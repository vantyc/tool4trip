/**
 * Places the trip board can draw without a network lookup: airports by IATA
 * code plus city aliases. Coordinates are approximate (map display only).
 * Unknown places still work; they compare by folded name and get their
 * coordinates from Wikipedia at runtime.
 */

export type PlaceInfo = {
  /** Canonical comparison key (city level: MNL and "Manila" share it). */
  key: string
  code?: string
  city: string
  airport?: string
  country: string
  lat: number
  lon: number
  /** IANA zone, used to stamp offsets on edited wall-clock times. */
  tz: string
  /** English Wikipedia title for the place photo. */
  wiki?: string
}

type Row = [
  code: string,
  city: string,
  airport: string,
  country: string,
  lat: number,
  lon: number,
  tz: string,
  wiki?: string,
  aliases?: string[],
]

const MX = 'México'
const US = 'Estados Unidos'
const PH = 'Filipinas'

const ROWS: Row[] = [
  ['MEX', 'Ciudad de México', 'AICM Benito Juárez', MX, 19.436, -99.072, 'America/Mexico_City', 'Mexico City', ['cdmx', 'ciudad de mexico', 'mexico city', 'mexico df', 'df']],
  ['NLU', 'Ciudad de México', 'AIFA Felipe Ángeles', MX, 19.756, -99.015, 'America/Mexico_City', 'Mexico City', ['aifa', 'santa lucia']],
  ['GDL', 'Guadalajara', 'Miguel Hidalgo', MX, 20.522, -103.311, 'America/Mexico_City', 'Guadalajara'],
  ['MTY', 'Monterrey', 'Mariano Escobedo', MX, 25.778, -100.107, 'America/Monterrey', 'Monterrey'],
  ['CUN', 'Cancún', 'Aeropuerto de Cancún', MX, 21.037, -86.877, 'America/Cancun', 'Cancún'],
  ['TQO', 'Tulum', 'Felipe Carrillo Puerto', MX, 20.091, -87.62, 'America/Cancun', 'Tulum'],
  ['CZM', 'Cozumel', 'Aeropuerto de Cozumel', MX, 20.522, -86.926, 'America/Cancun', 'Cozumel'],
  ['MID', 'Mérida', 'Manuel Crescencio Rejón', MX, 20.937, -89.658, 'America/Merida', 'Mérida, Yucatán'],
  ['SJD', 'Los Cabos', 'Aeropuerto de Los Cabos', MX, 23.152, -109.721, 'America/Mazatlan', 'Los Cabos Municipality', ['cabo san lucas', 'san jose del cabo']],
  ['LAP', 'La Paz', 'Manuel Márquez de León', MX, 24.073, -110.362, 'America/Mazatlan', 'La Paz, Baja California Sur'],
  ['PVR', 'Puerto Vallarta', 'Gustavo Díaz Ordaz', MX, 20.68, -105.254, 'America/Mexico_City', 'Puerto Vallarta'],
  ['OAX', 'Oaxaca', 'Xoxocotlán', MX, 16.999, -96.727, 'America/Mexico_City', 'Oaxaca City'],
  ['HUX', 'Huatulco', 'Bahías de Huatulco', MX, 15.775, -96.263, 'America/Mexico_City', 'Huatulco'],
  ['PXM', 'Puerto Escondido', 'Aeropuerto de Puerto Escondido', MX, 15.877, -97.089, 'America/Mexico_City', 'Puerto Escondido, Oaxaca'],
  ['TIJ', 'Tijuana', 'Abelardo L. Rodríguez', MX, 32.541, -116.97, 'America/Tijuana', 'Tijuana'],
  ['BJX', 'León', 'Del Bajío', MX, 20.993, -101.481, 'America/Mexico_City', 'León, Guanajuato', ['guanajuato', 'leon guanajuato']],
  ['QRO', 'Querétaro', 'Aeropuerto de Querétaro', MX, 20.617, -100.186, 'America/Mexico_City', 'Querétaro City'],
  ['AGU', 'Aguascalientes', 'Jesús Terán', MX, 21.705, -102.318, 'America/Mexico_City', 'Aguascalientes City'],
  ['SLP', 'San Luis Potosí', 'Ponciano Arriaga', MX, 22.254, -100.931, 'America/Mexico_City', 'San Luis Potosí City'],
  ['ZCL', 'Zacatecas', 'Leobardo C. Ruiz', MX, 22.897, -102.687, 'America/Mexico_City', 'Zacatecas City'],
  ['MLM', 'Morelia', 'Francisco J. Mújica', MX, 19.85, -101.025, 'America/Mexico_City', 'Morelia'],
  ['VER', 'Veracruz', 'Heriberto Jara', MX, 19.146, -96.187, 'America/Mexico_City', 'Veracruz, Veracruz'],
  ['TGZ', 'Tuxtla Gutiérrez', 'Ángel Albino Corzo', MX, 16.563, -93.022, 'America/Mexico_City', 'Tuxtla Gutiérrez', ['san cristobal de las casas']],
  ['VSA', 'Villahermosa', 'Carlos Rovirosa', MX, 17.997, -92.817, 'America/Mexico_City', 'Villahermosa'],
  ['ACA', 'Acapulco', 'Juan N. Álvarez', MX, 16.757, -99.754, 'America/Mexico_City', 'Acapulco'],
  ['ZIH', 'Ixtapa-Zihuatanejo', 'Aeropuerto de Zihuatanejo', MX, 17.602, -101.461, 'America/Mexico_City', 'Zihuatanejo', ['ixtapa', 'zihuatanejo']],
  ['MZT', 'Mazatlán', 'Rafael Buelna', MX, 23.161, -106.266, 'America/Mazatlan', 'Mazatlán'],
  ['CUL', 'Culiacán', 'Bachigualato', MX, 24.765, -107.475, 'America/Mazatlan', 'Culiacán'],
  ['HMO', 'Hermosillo', 'Ignacio L. Pesqueira', MX, 29.096, -111.048, 'America/Hermosillo', 'Hermosillo'],
  ['CUU', 'Chihuahua', 'Roberto Fierro', MX, 28.703, -105.965, 'America/Chihuahua', 'Chihuahua City'],
  ['CJS', 'Ciudad Juárez', 'Abraham González', MX, 31.636, -106.429, 'America/Ciudad_Juarez', 'Ciudad Juárez'],

  ['SFO', 'San Francisco', 'San Francisco International', US, 37.619, -122.375, 'America/Los_Angeles', 'San Francisco'],
  ['OAK', 'Oakland', 'Oakland International', US, 37.721, -122.221, 'America/Los_Angeles', 'Oakland, California'],
  ['SJC', 'San José (California)', 'Mineta San José', US, 37.363, -121.929, 'America/Los_Angeles', 'San Jose, California'],
  ['LAX', 'Los Ángeles', 'Los Angeles International', US, 33.942, -118.408, 'America/Los_Angeles', 'Los Angeles', ['los angeles']],
  ['SAN', 'San Diego', 'San Diego International', US, 32.734, -117.19, 'America/Los_Angeles', 'San Diego'],
  ['SEA', 'Seattle', 'Seattle-Tacoma', US, 47.45, -122.309, 'America/Los_Angeles', 'Seattle'],
  ['PDX', 'Portland', 'Portland International', US, 45.589, -122.597, 'America/Los_Angeles', 'Portland, Oregon'],
  ['LAS', 'Las Vegas', 'Harry Reid', US, 36.084, -115.154, 'America/Los_Angeles', 'Las Vegas'],
  ['PHX', 'Phoenix', 'Sky Harbor', US, 33.437, -112.008, 'America/Phoenix', 'Phoenix, Arizona'],
  ['DEN', 'Denver', 'Denver International', US, 39.856, -104.674, 'America/Denver', 'Denver'],
  ['DFW', 'Dallas', 'Dallas/Fort Worth', US, 32.897, -97.038, 'America/Chicago', 'Dallas'],
  ['IAH', 'Houston', 'George Bush Intercontinental', US, 29.99, -95.337, 'America/Chicago', 'Houston'],
  ['ORD', 'Chicago', "O'Hare", US, 41.978, -87.905, 'America/Chicago', 'Chicago'],
  ['ATL', 'Atlanta', 'Hartsfield-Jackson', US, 33.637, -84.428, 'America/New_York', 'Atlanta'],
  ['MIA', 'Miami', 'Miami International', US, 25.793, -80.291, 'America/New_York', 'Miami'],
  ['MCO', 'Orlando', 'Orlando International', US, 28.431, -81.308, 'America/New_York', 'Orlando, Florida'],
  ['JFK', 'Nueva York', 'John F. Kennedy', US, 40.641, -73.778, 'America/New_York', 'New York City', ['nueva york', 'new york', 'nyc']],
  ['EWR', 'Newark', 'Newark Liberty', US, 40.69, -74.174, 'America/New_York', 'Newark, New Jersey'],
  ['BOS', 'Boston', 'Logan', US, 42.366, -71.01, 'America/New_York', 'Boston'],
  ['IAD', 'Washington', 'Dulles', US, 38.953, -77.456, 'America/New_York', 'Washington, D.C.'],
  ['HNL', 'Honolulu', 'Daniel K. Inouye', US, 21.319, -157.922, 'Pacific/Honolulu', 'Honolulu'],

  ['YVR', 'Vancouver', 'Vancouver International', 'Canadá', 49.195, -123.184, 'America/Vancouver', 'Vancouver'],
  ['YYZ', 'Toronto', 'Pearson', 'Canadá', 43.678, -79.625, 'America/Toronto', 'Toronto'],
  ['YUL', 'Montreal', 'Trudeau', 'Canadá', 45.47, -73.741, 'America/Toronto', 'Montreal'],

  ['PTY', 'Ciudad de Panamá', 'Tocumen', 'Panamá', 9.071, -79.383, 'America/Panama', 'Panama City', ['panama']],
  ['SJO', 'San José (Costa Rica)', 'Juan Santamaría', 'Costa Rica', 9.994, -84.209, 'America/Costa_Rica', 'San José, Costa Rica'],
  ['HAV', 'La Habana', 'José Martí', 'Cuba', 22.989, -82.409, 'America/Havana', 'Havana', ['habana', 'havana']],
  ['BOG', 'Bogotá', 'El Dorado', 'Colombia', 4.702, -74.147, 'America/Bogota', 'Bogotá'],
  ['MDE', 'Medellín', 'José María Córdova', 'Colombia', 6.165, -75.423, 'America/Bogota', 'Medellín'],
  ['LIM', 'Lima', 'Jorge Chávez', 'Perú', -12.022, -77.114, 'America/Lima', 'Lima'],
  ['SCL', 'Santiago de Chile', 'Arturo Merino Benítez', 'Chile', -33.393, -70.786, 'America/Santiago', 'Santiago', ['santiago']],
  ['EZE', 'Buenos Aires', 'Ezeiza', 'Argentina', -34.822, -58.536, 'America/Argentina/Buenos_Aires', 'Buenos Aires'],
  ['GRU', 'São Paulo', 'Guarulhos', 'Brasil', -23.435, -46.473, 'America/Sao_Paulo', 'São Paulo', ['sao paulo']],

  ['MAD', 'Madrid', 'Barajas', 'España', 40.472, -3.561, 'Europe/Madrid', 'Madrid'],
  ['BCN', 'Barcelona', 'El Prat', 'España', 41.297, 2.078, 'Europe/Madrid', 'Barcelona'],
  ['LIS', 'Lisboa', 'Humberto Delgado', 'Portugal', 38.774, -9.134, 'Europe/Lisbon', 'Lisbon', ['lisbon']],
  ['LHR', 'Londres', 'Heathrow', 'Reino Unido', 51.47, -0.454, 'Europe/London', 'London', ['london']],
  ['CDG', 'París', 'Charles de Gaulle', 'Francia', 49.01, 2.548, 'Europe/Paris', 'Paris', ['paris']],
  ['AMS', 'Ámsterdam', 'Schiphol', 'Países Bajos', 52.31, 4.768, 'Europe/Amsterdam', 'Amsterdam', ['amsterdam']],
  ['FRA', 'Fráncfort', 'Frankfurt am Main', 'Alemania', 50.038, 8.562, 'Europe/Berlin', 'Frankfurt', ['frankfurt']],
  ['MUC', 'Múnich', 'Franz Josef Strauss', 'Alemania', 48.354, 11.786, 'Europe/Berlin', 'Munich', ['munich']],
  ['ZRH', 'Zúrich', 'Kloten', 'Suiza', 47.465, 8.549, 'Europe/Zurich', 'Zürich', ['zurich']],
  ['FCO', 'Roma', 'Fiumicino', 'Italia', 41.8, 12.239, 'Europe/Rome', 'Rome', ['rome']],
  ['IST', 'Estambul', 'Aeropuerto de Estambul', 'Turquía', 41.262, 28.742, 'Europe/Istanbul', 'Istanbul', ['istanbul']],
  ['DXB', 'Dubái', 'Dubai International', 'Emiratos Árabes Unidos', 25.253, 55.364, 'Asia/Dubai', 'Dubai', ['dubai']],
  ['DOH', 'Doha', 'Hamad', 'Catar', 25.273, 51.608, 'Asia/Qatar', 'Doha'],

  ['NRT', 'Tokio', 'Narita', 'Japón', 35.772, 140.393, 'Asia/Tokyo', 'Tokyo', ['tokio', 'tokyo']],
  ['HND', 'Tokio', 'Haneda', 'Japón', 35.549, 139.78, 'Asia/Tokyo', 'Tokyo'],
  ['ICN', 'Seúl', 'Incheon', 'Corea del Sur', 37.46, 126.441, 'Asia/Seoul', 'Seoul', ['seul', 'seoul']],
  ['PVG', 'Shanghái', 'Pudong', 'China', 31.143, 121.805, 'Asia/Shanghai', 'Shanghai', ['shanghai']],
  ['HKG', 'Hong Kong', 'Hong Kong International', 'China', 22.308, 113.918, 'Asia/Hong_Kong', 'Hong Kong'],
  ['TPE', 'Taipéi', 'Taoyuan', 'Taiwán', 25.078, 121.233, 'Asia/Taipei', 'Taipei', ['taipei']],
  ['SIN', 'Singapur', 'Changi', 'Singapur', 1.364, 103.991, 'Asia/Singapore', 'Singapore', ['singapore']],
  ['BKK', 'Bangkok', 'Suvarnabhumi', 'Tailandia', 13.69, 100.75, 'Asia/Bangkok', 'Bangkok'],
  ['KUL', 'Kuala Lumpur', 'KLIA', 'Malasia', 2.746, 101.71, 'Asia/Kuala_Lumpur', 'Kuala Lumpur'],
  ['CGK', 'Yakarta', 'Soekarno-Hatta', 'Indonesia', -6.126, 106.656, 'Asia/Jakarta', 'Jakarta', ['jakarta']],
  ['DPS', 'Bali', 'Ngurah Rai', 'Indonesia', -8.748, 115.167, 'Asia/Makassar', 'Bali', ['denpasar']],
  ['SGN', 'Ciudad Ho Chi Minh', 'Tan Son Nhat', 'Vietnam', 10.819, 106.652, 'Asia/Ho_Chi_Minh', 'Ho Chi Minh City', ['ho chi minh', 'saigon']],
  ['HAN', 'Hanói', 'Noi Bai', 'Vietnam', 21.221, 105.807, 'Asia/Bangkok', 'Hanoi', ['hanoi']],
  ['DEL', 'Delhi', 'Indira Gandhi', 'India', 28.556, 77.1, 'Asia/Kolkata', 'Delhi', ['nueva delhi', 'new delhi']],
  ['SYD', 'Sídney', 'Kingsford Smith', 'Australia', -33.946, 151.177, 'Australia/Sydney', 'Sydney', ['sydney']],

  ['MNL', 'Manila', 'Ninoy Aquino (NAIA)', PH, 14.509, 121.02, 'Asia/Manila', 'Manila', ['metro manila', 'makati', 'taguig', 'bonifacio global city', 'bgc', 'pasay', 'quezon city', 'naia']],
  ['CRK', 'Clark', 'Clark International', PH, 15.186, 120.56, 'Asia/Manila', 'Clark Freeport Zone', ['angeles', 'pampanga']],
  ['CEB', 'Cebú', 'Mactan-Cebu International', PH, 10.307, 123.979, 'Asia/Manila', 'Cebu City', ['cebu', 'cebu city', 'mactan', 'lapu-lapu', 'lapu lapu']],
  ['ENI', 'El Nido', 'Aeropuerto de Lio', PH, 11.202, 119.416, 'Asia/Manila', 'El Nido, Palawan', ['el nido', 'lio']],
  ['PPS', 'Puerto Princesa', 'Aeropuerto de Puerto Princesa', PH, 9.742, 118.759, 'Asia/Manila', 'Puerto Princesa'],
  ['USU', 'Coron', 'Francisco B. Reyes (Busuanga)', PH, 12.121, 120.1, 'Asia/Manila', 'Coron, Palawan', ['coron', 'busuanga']],
  ['MPH', 'Boracay', 'Godofredo P. Ramos (Caticlan)', PH, 11.925, 121.954, 'Asia/Manila', 'Boracay', ['caticlan', 'malay aklan']],
  ['KLO', 'Kalibo', 'Kalibo International', PH, 11.679, 122.376, 'Asia/Manila', 'Kalibo'],
  ['TAG', 'Bohol (Panglao)', 'Bohol-Panglao International', PH, 9.664, 123.853, 'Asia/Manila', 'Panglao, Bohol', ['panglao', 'bohol', 'tagbilaran']],
  ['IAO', 'Siargao', 'Sayak', PH, 9.859, 126.014, 'Asia/Manila', 'Siargao', ['general luna']],
  ['DVO', 'Davao', 'Francisco Bangoy', PH, 7.125, 125.646, 'Asia/Manila', 'Davao City'],
  ['ILO', 'Iloilo', 'Iloilo International', PH, 10.833, 122.493, 'Asia/Manila', 'Iloilo City'],
  ['BCD', 'Bacolod', 'Bacolod-Silay', PH, 10.776, 123.015, 'Asia/Manila', 'Bacolod'],
]

export function foldPlace(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const BY_CODE = new Map<string, PlaceInfo>()
const BY_ALIAS = new Map<string, PlaceInfo>()

for (const [code, city, airport, country, lat, lon, tz, wiki, aliases] of ROWS) {
  const info: PlaceInfo = {
    key: foldPlace(city).replace(/\s+/g, '-'),
    code,
    city,
    airport,
    country,
    lat,
    lon,
    tz,
    wiki,
  }
  BY_CODE.set(code, info)
  for (const alias of [city, ...(aliases ?? [])]) {
    const folded = foldPlace(alias)
    if (!BY_ALIAS.has(folded)) BY_ALIAS.set(folded, info)
  }
}

const ALIASES_LONGEST_FIRST = [...BY_ALIAS.keys()].sort(
  (a, b) => b.length - a.length,
)

/** Known place for an IATA code, a city name or a free-form address. */
export function resolvePlace(raw?: string | null): PlaceInfo | undefined {
  const text = raw?.trim()
  if (!text) return undefined
  const code = text.match(/^[A-Z]{3}$/)?.[0] ?? text.match(/\(([A-Z]{3})\)/)?.[1]
  if (code && BY_CODE.has(code)) return BY_CODE.get(code)
  const folded = foldPlace(text)
  if (!folded) return undefined
  const exact = BY_ALIAS.get(folded)
  if (exact) return exact
  const padded = ` ${folded} `
  for (const alias of ALIASES_LONGEST_FIRST) {
    if (alias.length >= 4 && padded.includes(` ${alias} `)) {
      return BY_ALIAS.get(alias)
    }
  }
  return undefined
}

/** Key that makes "MNL", "Manila" and "Taguig" the same stop. */
export function placeKey(raw?: string | null): string | undefined {
  const known = resolvePlace(raw)
  if (known) return known.key
  const folded = raw ? foldPlace(raw) : ''
  return folded ? folded.replace(/\s+/g, '-') : undefined
}

export function placeLabel(raw?: string | null): string {
  return resolvePlace(raw)?.city ?? raw?.trim() ?? '—'
}

export function airportLabel(raw?: string | null): string | undefined {
  const known = resolvePlace(raw)
  if (!known?.code) return raw?.trim() || undefined
  return `${known.code} · ${known.airport}`
}
