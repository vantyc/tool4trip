import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { requestWorkspace } from './ownership.ts'
import { migrate } from './schema.ts'
import { store } from './store.ts'

/** Minimal fake of `trips` keyed by (id, workspace) for DELETE statements. */
function fakeDb(rows: Array<{ id: string; workspace: string }>) {
  const queries: Array<{ text: string; params: unknown[] }> = []
  return {
    rows,
    queries,
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params })
      const m = /^DELETE FROM trips WHERE id = \$1 AND workspace = \$2$/.exec(text.trim())
      if (!m) throw new Error(`unexpected query: ${text}`)
      const before = rows.length
      const [id, workspace] = params
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.id === id && rows[i]!.workspace === workspace) rows.splice(i, 1)
      }
      return { rows: [], rowCount: before - rows.length }
    },
  }
}

const OWNER = 'owner@example'

describe('trip deletion is limited to the owner', () => {
  it('owner can delete their trip', async () => {
    const db = fakeDb([{ id: 'trip-1', workspace: 'default' }])
    const ws = requestWorkspace(OWNER, OWNER)
    assert.equal(ws, 'default')
    assert.equal(await store.deleteTrip(db as never, 'trip-1', ws!), true)
    assert.equal(db.rows.length, 0)
  })

  it('another user cannot delete it, even knowing its id', async () => {
    const db = fakeDb([{ id: 'trip-1', workspace: 'default' }])
    const ws = requestWorkspace('mallory', OWNER)
    assert.equal(ws, 'user:mallory')
    assert.equal(await store.deleteTrip(db as never, 'trip-1', ws!), false)
    assert.deepEqual(db.rows, [{ id: 'trip-1', workspace: 'default' }])
  })

  it('no authenticated user, or no configured owner → never the owner workspace', () => {
    assert.equal(requestWorkspace(undefined, OWNER), null)
    assert.equal(requestWorkspace('  ', OWNER), null)
    assert.equal(requestWorkspace(['a', 'b'], OWNER), null)
    assert.equal(requestWorkspace(OWNER, undefined), `user:${OWNER}`)
  })

  it('dependent tables cascade on trip deletion', async () => {
    let ddl = ''
    await migrate({ query: async (text: string) => { ddl += text; return { rows: [] } } } as never)
    const refs = ddl.match(/trip_id TEXT NOT NULL REFERENCES trips\(id\)[^,\n]*/g) ?? []
    assert.equal(refs.length, 7)
    assert.ok(refs.every((r) => r.includes('ON DELETE CASCADE')))
  })
})
