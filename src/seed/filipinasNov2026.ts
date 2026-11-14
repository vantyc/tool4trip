import type {
  ChecklistItem,
  Note,
  PackageImport,
  TravelOption,
  Trip,
} from '../domain/types'

/** Stable id. Later searches for this trip update this record. */
export const FILIPINAS_TRIP_ID = 'filipinas-nov-2026'
export const FILIPINAS_PACKAGE_ID = 'pkg-filipinas-nov-2026'

const CHECKED = '2026-11-03T18:42:00-06:00'

const SFO_MNL_28 =
  'https://www.skyscanner.com.mx/transporte/vuelos/sfo/mnl/261114/261128/?adultsv2=1&cabinclass=economy&currency=MXN&preferdirects=true'
const MEX_SFO_28 =
  'https://www.skyscanner.com.mx/transporte/vuelos/mex/sfo/261114/261128/?adultsv2=1&cabinclass=economy&currency=MXN&preferdirects=true'
const MEX_MNL_29 =
  'https://www.skyscanner.com.mx/transporte/vuelos/mex/mnl/261114/261129/?adultsv2=1&cabinclass=economy&currency=MXN'
const SFO_MNL_29 =
  'https://www.skyscanner.com.mx/transporte/vuelos/sfo/mnl/261114/261129/?adultsv2=1&cabinclass=economy&currency=MXN&preferdirects=true'
const MEX_SFO_29 =
  'https://www.skyscanner.com.mx/transporte/vuelos/mex/sfo/261114/261129/?adultsv2=1&cabinclass=economy&currency=MXN&preferdirects=true'
const LAX_MNL =
  'https://www.skyscanner.com.mx/transporte/vuelos/lax/mnl/261114/261129/?adultsv2=1&cabinclass=economy&currency=MXN&preferdirects=true'
const MEX_LAX =
  'https://www.skyscanner.com.mx/transporte/vuelos/mex/lax/261114/261129/?adultsv2=1&cabinclass=economy&currency=MXN&preferdirects=true'
const MNL_CEB =
  'https://www.kayak.com.mx/flights/MNL-CEB/2026-11-19?sort=duration_a'
const CEB_ENI =
  'https://www.kayak.com.mx/flights/CEB-ENI/2026-11-22?sort=duration_a'
const ENI_CEB =
  'https://www.kayak.com.mx/flights/ENI-CEB/2026-11-25?sort=duration_a'
const CEB_MNL =
  'https://www.kayak.com.mx/flights/CEB-MNL/2026-11-25?sort=duration_a'
const CRK_ENI =
  'https://www.kayak.com.mx/flights/CRK-ENI/2026-11-22?sort=price_a'
const ENI_CRK =
  'https://www.kayak.com.mx/flights/ENI-CRK/2026-11-25?sort=price_a'
const SEDA =
  'https://ayalalandhospitality.com/en/seda/hotels/seda-bgc-taguig/offers/festive-rooms'
const OKURA =
  'https://www.trivago.com/en-US/oar/hotel-okura-manila?search=100-11235918'
const HUNI =
  'https://www.trivago.com/en-US/oar/hotel-huni-lio-el-nido?search=100-13507802'
const SEDA_LIO =
  'https://www.trivago.com.ph/en-PH/oar/resort-seda-lio-el-nido?search=100-9993284'
/** Hosts Abyzz & Gavt accepted the Airbnb date change (one-time courtesy). */
const KANSO_CHANGE = '2026-11-14T04:07:00-06:00'
/** United profile primary email verified (for booking confirmations). */
const UNITED_EMAIL_CHANGE = '2026-11-14T04:50:00-06:00'
/** eTravel QR updated to arrival 17 Nov UA809 (ref F00NKZMH64BZ). */
const ETRAVEL_OK = '2026-11-14T06:56:00-06:00'
const UNITED_PRIMARY_EMAIL = 'rafael.carrasco.us@gmail.com'
export const FILIPINAS_ETRAVEL_DOC_ID = 'filipinas-nov-2026-doc-etravel'
export const FILIPINAS_ETRAVEL_QR_URL = '/seed/filipinas-etravel-F00NKZMH64BZ.png'

type Row = Omit<
  TravelOption,
  | 'tripId'
  | 'createdAt'
  | 'updatedAt'
  | 'syncStatus'
  | 'packageId'
  | 'sourceType'
> & { sourceType?: TravelOption['sourceType'] }

function row(partial: Row): TravelOption {
  return {
    tripId: FILIPINAS_TRIP_ID,
    packageId: FILIPINAS_PACKAGE_ID,
    createdAt: CHECKED,
    updatedAt: CHECKED,
    syncStatus: 'synced',
    sourceType: 'cursor',
    currency: 'MXN',
    checkedAt: CHECKED,
    ...partial,
  }
}

export function filipinasNov2026Bundle(): {
  trip: Trip
  travelOptions: TravelOption[]
  checklistItems: ChecklistItem[]
  notes: Note[]
  packageImports: PackageImport[]
} {
  const travelOptions: TravelOption[] = [
    row({
      id: 'filipinas-nov-2026-01-ua822',
      externalId: 'filipinas-nov-2026-01-ua822',
      type: 'flight',
      status: 'booked',
      budgetRole: 'primary',
      amountPaid: 0,
      title: 'United UA822 CDMX → San Francisco · HNW4J6',
      provider: 'United',
      origin: 'MEX',
      destination: 'SFO',
      startAt: '2026-11-16T05:45:00-06:00',
      endAt: '2026-11-16T08:44:00-08:00',
      priceObserved: 13105,
      priceHistory: [
        {
          amount: 11238,
          currency: 'MXN',
          checkedAt: CHECKED,
          sourceUrl: MEX_SFO_28,
        },
      ],
      sourceUrl: MEX_SFO_28,
      verificationStatus: 'verified',
      nextAction:
        'Reenviar eTicket HNW4J6 a Gmail. Confirmar asiento $59.99 y maleta en la reserva.',
      notes:
        'Comprado HNW4J6. Ida 16 nov MEX→SFO. Hueco hasta UA809: 5 h 21 min. Precio de referencia cotizado 13,105 MXN con maleta (confirmar en boleto).',
    }),
    row({
      id: 'filipinas-nov-2026-02-ua809',
      externalId: 'filipinas-nov-2026-02-ua809',
      type: 'flight',
      status: 'booked',
      budgetRole: 'primary',
      amountPaid: 0,
      title: 'United UA809 San Francisco → Manila · HNW4J6',
      provider: 'United',
      origin: 'SFO',
      destination: 'MNL',
      startAt: '2026-11-16T14:05:00-08:00',
      endAt: '2026-11-17T21:10:00+08:00',
      priceObserved: 18523,
      sourceUrl: SFO_MNL_28,
      verificationStatus: 'verified',
      nextAction: 'Confirmar pasillo y eTicket en Manage Trip HNW4J6.',
      notes:
        'Comprado HNW4J6. SFO→MNL llegada 17 nov 21:10 MNL T3. Mismo boleto que UA190 de regreso.',
    }),
    row({
      id: 'filipinas-nov-2026-03-ua190',
      externalId: 'filipinas-nov-2026-03-ua190',
      type: 'flight',
      status: 'booked',
      budgetRole: 'primary',
      countsInBudget: false,
      amountPaid: 0,
      title: 'Regreso United UA190 Manila → San Francisco · HNW4J6',
      provider: 'United',
      origin: 'MNL',
      destination: 'SFO',
      startAt: '2026-11-28T09:55:00+08:00',
      endAt: '2026-11-28T06:35:00-08:00',
      priceObserved: 18523,
      sourceUrl: SFO_MNL_28,
      verificationStatus: 'verified',
      nextAction: 'Confirmar tramo de regreso en eTicket HNW4J6 (hora 09:55).',
      notes:
        'Mismo boleto HNW4J6 que UA809. Sale de Manila el sábado 28 a las 09:55 (confirmar en reserva).',
    }),
    row({
      id: 'filipinas-nov-2026-04-ua817',
      externalId: 'filipinas-nov-2026-04-ua817',
      type: 'flight',
      status: 'booked',
      budgetRole: 'primary',
      countsInBudget: false,
      amountPaid: 0,
      title: 'Regreso United UA817 San Francisco → CDMX · HNW4J6',
      provider: 'United',
      origin: 'SFO',
      destination: 'MEX',
      startAt: '2026-11-28T13:14:00-08:00',
      endAt: '2026-11-28T19:35:00-06:00',
      priceObserved: 13105,
      sourceUrl: MEX_SFO_28,
      verificationStatus: 'verified',
      nextAction: 'Confirmar llegada CDMX ~19:35 en eTicket HNW4J6.',
      notes:
        'Mismo boleto HNW4J6 que UA822. Aterriza en CDMX el sábado 28 a las 19:35 (confirmar en reserva).',
    }),
    row({
      id: 'filipinas-nov-2026-alt-united-unico',
      externalId: 'filipinas-nov-2026-alt-united-unico',
      type: 'flight',
      status: 'shortlisted',
      budgetRole: 'alternative',
      title: 'Alternativa — United un solo boleto CDMX–Manila 14–29',
      provider: 'United',
      origin: 'MEX',
      destination: 'MNL',
      startAt: '2026-11-14T05:45:00-06:00',
      endAt: '2026-11-29T17:05:00-06:00',
      priceObserved: 40886,
      sourceUrl: MEX_MNL_29,
      verificationStatus: 'verified',
      nextAction: 'Dejarla como respaldo de un solo boleto. No sumar ni reservar.',
      notes:
        'UA822, UA809, UA190 y UA1271. Una reserva. Dos maletas de 23 kg en todo el viaje, asiento incluido, cambios gratis, sin reembolso. Llega a CDMX el domingo 29 a las 17:05. El hueco de regreso en SFO es de 4 h 10 min. Cotizado, sin reserva ni pago. No entra al subtotal.',
    }),
    row({
      id: 'filipinas-nov-2026-alt-sfo-mnl-29',
      externalId: 'filipinas-nov-2026-alt-sfo-mnl-29',
      type: 'flight',
      status: 'shortlisted',
      budgetRole: 'alternative',
      title: 'Alternativa — United SFO–Manila, Manila sale el 29',
      provider: 'United',
      origin: 'SFO',
      destination: 'MNL',
      startAt: '2026-11-14T14:05:00-08:00',
      endAt: '2026-11-29T06:35:00-08:00',
      priceObserved: 25008,
      sourceUrl: SFO_MNL_29,
      verificationStatus: 'verified',
      nextAction: 'Solo si se quiere dormir en Manila la noche del 28. No sumar.',
      notes:
        'Mismos UA809 y UA190, con salida de Manila el 29 a las 09:55. Dos maletas de 23 kg. Junto con el MEX–SFO del 29 suma 36,246. No entra al subtotal.',
    }),
    row({
      id: 'filipinas-nov-2026-alt-mex-sfo-29',
      externalId: 'filipinas-nov-2026-alt-mex-sfo-29',
      type: 'flight',
      status: 'shortlisted',
      budgetRole: 'alternative',
      title: 'Alternativa — United CDMX–SFO 14–29',
      provider: 'United',
      origin: 'MEX',
      destination: 'SFO',
      startAt: '2026-11-14T05:45:00-06:00',
      endAt: '2026-11-29T19:35:00-06:00',
      priceObserved: 11238,
      sourceUrl: MEX_SFO_29,
      verificationStatus: 'verified',
      nextAction: 'No sumar. El Basic no incluye maleta.',
      notes:
        'Basic Economy, 11,238 MXN, solo artículo personal. El regreso de las 13:14 llega a CDMX el 29 a las 19:35 y deja 6 h 39 min. UA1271 a las 10:45 deja 4 h 10 min. No entra al subtotal.',
    }),
    row({
      id: 'filipinas-nov-2026-alt-lax-mnl',
      externalId: 'filipinas-nov-2026-alt-lax-mnl',
      type: 'flight',
      status: 'shortlisted',
      budgetRole: 'alternative',
      title: 'Alternativa — Philippine Airlines LAX–Manila',
      provider: 'Philippine Airlines',
      origin: 'LAX',
      destination: 'MNL',
      startAt: '2026-11-14T22:05:00-08:00',
      endAt: '2026-11-29T08:05:00-08:00',
      priceObserved: 35623,
      sourceUrl: LAX_MNL,
      verificationStatus: 'verified',
      nextAction: 'No usar: el par con CDMX–LAX suma 46,980 y sale más caro.',
      notes:
        'PR103 sale de LAX el 14 a las 22:05 y llega a Manila el 16 a las 05:35. PR112 sale de Manila el 29 a las 11:10 y llega a LAX a las 08:05. Abierto en Gotogate: trae mano y documentada; el peso no se desplegó. No entra al subtotal.',
    }),
    row({
      id: 'filipinas-nov-2026-alt-mex-lax',
      externalId: 'filipinas-nov-2026-alt-mex-lax',
      type: 'flight',
      status: 'shortlisted',
      budgetRole: 'alternative',
      title: 'Alternativa — Aeroméxico CDMX–Los Ángeles 14–29',
      provider: 'Aeromexico',
      origin: 'MEX',
      destination: 'LAX',
      startAt: '2026-11-14T07:25:00-06:00',
      endAt: '2026-11-29T19:35:00-06:00',
      priceObserved: 11357,
      sourceUrl: MEX_LAX,
      verificationStatus: 'verified',
      nextAction: 'No sumar. Sin maleta en la tarifa abierta.',
      notes:
        'AM646 07:25–09:45 el 14. AM645 sale de LAX el 29 a las 13:48 y llega a CDMX a las 19:35. eDreams, 11,357 MXN, sin mano ni documentada. El hueco con PR112 es de 5 h 43 min. No entra al subtotal.',
    }),
    row({
      id: 'filipinas-nov-2026-p-mnl-ceb',
      externalId: 'filipinas-nov-2026-p-mnl-ceb',
      type: 'flight',
      status: 'booked',
      budgetRole: 'primary',
      amountPaid: 7402.32,
      countsInBudget: false,
      title: 'Cebu Pacific 5J 569 Manila → Cebú · ZLW9UW · 19 nov 17:45–19:20',
      provider: 'Cebu Pacific',
      origin: 'MNL',
      destination: 'CEB',
      // Times live in title/notes so lodging stays stay merged on the board.
      priceObserved: 7402.32,
      currency: 'PHP',
      sourceUrl: MNL_CEB,
      verificationStatus: 'verified',
      nextAction: 'Asiento Unassigned (opcional).',
      notes:
        '19 nov 2026 · MNL T3 17:45 → CEB T1 19:20 · TXN 303911537 · Payment RXMWD1.',
    }),
    row({
      id: 'filipinas-nov-2026-p-ceb-eni',
      externalId: 'filipinas-nov-2026-p-ceb-eni',
      type: 'flight',
      status: 'booked',
      budgetRole: 'primary',
      amountPaid: 12432.32,
      countsInBudget: false,
      title: 'Cebgo DG6254 Cebú → El Nido · GWSE2U · 22 nov 18:50–20:35',
      provider: 'Cebu Pacific / Cebgo',
      origin: 'CEB',
      destination: 'ENI',
      priceObserved: 12432.32,
      currency: 'PHP',
      sourceUrl: CEB_ENI,
      verificationStatus: 'verified',
      nextAction: 'Asiento Unassigned (opcional).',
      notes:
        '22 nov 2026 · CEB T1 18:50 → ENI 20:35 · TXN 303911850 · Payment 7M5K2O.',
    }),
    row({
      id: 'filipinas-nov-2026-p-eni-ceb',
      externalId: 'filipinas-nov-2026-p-eni-ceb',
      type: 'flight',
      status: 'booked',
      budgetRole: 'primary',
      amountPaid: 0,
      countsInBudget: false,
      title: 'Cebgo DG6257 El Nido → Cebú · BG8LUF · 25 nov 10:45–12:30',
      provider: 'Cebu Pacific / Cebgo',
      origin: 'ENI',
      destination: 'CEB',
      priceObserved: 19086.24,
      currency: 'PHP',
      sourceUrl: ENI_CEB,
      verificationStatus: 'verified',
      nextAction: 'Conexión 2 h en CEB T1 hacia 5J 552.',
      notes:
        '25 nov 2026 · ENI 10:45 → CEB 12:30. Misma reserva BG8LUF que 5J 552 · total PHP 19,086.24 · TXN 303912379.',
    }),
    row({
      id: 'filipinas-nov-2026-p-ceb-mnl',
      externalId: 'filipinas-nov-2026-p-ceb-mnl',
      type: 'flight',
      status: 'booked',
      budgetRole: 'primary',
      amountPaid: 19086.24,
      countsInBudget: false,
      title: 'Cebu Pacific 5J 552 Cebú → Manila · BG8LUF · 25 nov 14:30–16:05',
      provider: 'Cebu Pacific',
      origin: 'CEB',
      destination: 'MNL',
      priceObserved: 19086.24,
      currency: 'PHP',
      sourceUrl: CEB_MNL,
      verificationStatus: 'verified',
      nextAction: 'Llegada MNL T3 16:05 → hotel Manila 2ª vez.',
      notes:
        '25 nov 2026 · CEB 14:30 → MNL 16:05. Misma reserva BG8LUF que DG6257 · conexión 2 h.',
    }),
    row({
      id: 'filipinas-nov-2026-p-crk-eni',
      externalId: 'filipinas-nov-2026-p-crk-eni',
      type: 'flight',
      status: 'researched',
      budgetRole: 'alternative',
      title: 'Alternativa no elegida — Clark → El Nido, 22 nov',
      provider: 'Cebgo',
      origin: 'CRK',
      destination: 'ENI',
      sourceUrl: CRK_ENI,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction: 'No usar: ruta elegida es Cebú.',
      notes: 'Ruta Clark descartada. Itinerario real: CEB→ENI DG6254 el 22.',
    }),
    row({
      id: 'filipinas-nov-2026-p-eni-crk',
      externalId: 'filipinas-nov-2026-p-eni-crk',
      type: 'flight',
      status: 'researched',
      budgetRole: 'alternative',
      title: 'Alternativa no elegida — El Nido → Clark, 25 nov',
      provider: 'Cebgo',
      origin: 'ENI',
      destination: 'CRK',
      sourceUrl: ENI_CRK,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction: 'No usar: ruta elegida es Cebú.',
      notes: 'Ruta Clark descartada. Itinerario real: ENI→CEB→MNL el 25.',
    }),
    row({
      id: 'filipinas-nov-2026-p-car-mnl-crk',
      externalId: 'filipinas-nov-2026-p-car-mnl-crk',
      type: 'transfer',
      status: 'researched',
      budgetRole: 'alternative',
      title: 'Alternativa no elegida — auto Manila → Clark',
      origin: 'Manila',
      destination: 'CRK',
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction: 'No usar.',
      notes: 'Descartado: se vuela MNL→CEB el 19 (ZLW9UW).',
    }),
    row({
      id: 'filipinas-nov-2026-p-car-crk-mnl',
      externalId: 'filipinas-nov-2026-p-car-crk-mnl',
      type: 'transfer',
      status: 'researched',
      budgetRole: 'alternative',
      title: 'Alternativa no elegida — auto Clark → Manila',
      origin: 'CRK',
      destination: 'Manila',
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction: 'No usar.',
      notes: 'Descartado: se vuela CEB→MNL el 25 (BG8LUF).',
    }),
    row({
      id: 'filipinas-nov-2026-p-hotel-mnl-15',
      externalId: 'filipinas-nov-2026-p-hotel-mnl-15',
      type: 'lodging',
      status: 'booked',
      budgetRole: 'primary',
      amountPaid: 66.69,
      countsInBudget: false,
      title: 'Airbnb Kanso 簡素 Makati Home, 17 al 19 nov 2026',
      provider: 'Airbnb — Abyzz y Gavt',
      destination: 'Makati',
      address: 'Makati, Metro Manila',
      startAt: '2026-11-17T15:00:00+08:00',
      endAt: '2026-11-19T11:00:00+08:00',
      checkedAt: KANSO_CHANGE,
      verificationStatus: 'verified',
      currency: 'USD',
      nextAction:
        'Check-in ~23:00 ok. Verificar reembolso US$53.76 en VISA •4146. HM49PCXDDQ.',
      notes:
        'Confirmación HM49PCXDDQ / recibo RCDNTK3F2W. Total US$66.69 tras cambio 17–19. Seda/Okura ya no aplican. ' +
        SEDA +
        ` · ${OKURA}.`,
    }),
    row({
      id: 'filipinas-nov-2026-p-hotel-ceb',
      externalId: 'filipinas-nov-2026-p-hotel-ceb',
      type: 'lodging',
      status: 'booked',
      budgetRole: 'primary',
      amountPaid: 0,
      title: 'Airbnb Sleek Studio Cebú, 19 al 22 nov 2026',
      provider: 'Airbnb',
      destination: 'Cebú',
      address: 'Cebu City · Steps from Ayala',
      startAt: '2026-11-19T15:00:00+08:00',
      endAt: '2026-11-22T11:00:00+08:00',
      checkedAt: ETRAVEL_OK,
      verificationStatus: 'verified',
      currency: undefined,
      nextAction: 'Anotar código HM… y monto del recibo Gmail.',
      notes:
        'Confirmado en Gmail (recibo 19–22 nov + reminder 12 nov). Código y monto pendientes de captura.',
    }),
    row({
      id: 'filipinas-nov-2026-p-hotel-mnl-27',
      externalId: 'filipinas-nov-2026-p-hotel-mnl-27',
      type: 'lodging',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — hotel en Manila, 25 al 28 nov 2026',
      provider: 'Seda BGC',
      destination: 'Manila',
      address: 'Bonifacio Global City, Taguig',
      startAt: '2026-11-25T15:00:00+08:00',
      endAt: '2026-11-28T07:00:00+08:00',
      sourceUrl: SEDA,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction:
        'Cotizar 25–28 (llegas MNL ~16:05 el 25; sale UA190 el 28 a las 09:55).',
      notes: `Tres noches. Okura: ${OKURA}. Sin cotización.`,
    }),
    row({
      id: 'filipinas-nov-2026-p-hotel-eni',
      externalId: 'filipinas-nov-2026-p-hotel-eni',
      type: 'lodging',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — hotel en El Nido, 22 al 25 nov 2026',
      provider: 'Huni Lio',
      destination: 'El Nido',
      startAt: '2026-11-22T15:00:00+08:00',
      endAt: '2026-11-25T11:00:00+08:00',
      sourceUrl: HUNI,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction:
        'Cotizar Huni Lio / Seda Lio 22–25 (3 noches), con impuestos y cancelación.',
      notes: `Tres noches. Llegas ENI ~20:35 el 22; sales DG6257 el 25 a las 10:45. Seda Lio: ${SEDA_LIO}.`,
    }),
    row({
      id: 'filipinas-nov-2026-p-asiento',
      externalId: 'filipinas-nov-2026-p-asiento',
      type: 'activity',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — asiento de pasillo',
      provider: 'United',
      origin: 'SFO',
      destination: 'MNL',
      sourceUrl: SFO_MNL_28,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction:
        'Elegir pasillo en UA809 y UA190 al comprar: va incluido. Cotizar el asiento del Basic CDMX–SFO; en esa tarifa es extra y no tiene precio.',
      notes:
        'Sin cotización del asiento en el tramo corto. El tramo largo lo incluye.',
    }),
  ]

  const trip: Trip = {
    id: FILIPINAS_TRIP_ID,
    title: 'Filipinas, noviembre 2026',
    destination: 'Manila, Cebú y El Nido',
    startDate: '2026-11-16',
    endDate: '2026-11-29',
    timezone: 'America/Mexico_City',
    goals: [
      {
        id: 'filipinas-meta-noches',
        label: 'Manila → Cebú → El Nido → Manila',
      },
      {
        id: 'filipinas-meta-regreso',
        label: 'Salir de CDMX el 16 y estar de vuelta a más tardar el 29',
      },
    ],
    status: 'planned',
    notes:
      'United HNW4J6: ida 16 nov UA822+UA809, Manila 17 nov 21:10. Kanso 17–19. Cebú 19–22 (5J 569 + Sleek Studio). El Nido 22–25 (DG6254). Regreso ENI→CEB→MNL 25 (BG8LUF); United ~28 nov. eTravel F00NKZMH64BZ OK. Correo United: ' +
      UNITED_PRIMARY_EMAIL +
      '.',
    createdAt: CHECKED,
    updatedAt: ETRAVEL_OK,
    syncStatus: 'synced',
  }

  const checklistItems: ChecklistItem[] = [
    {
      id: 'filipinas-nov-2026-ck-visa',
      tripId: FILIPINAS_TRIP_ID,
      label:
        'Confirmar visa vigente de Estados Unidos. San Francisco y Los Ángeles no son tránsito estéril.',
      status: 'open',
      sortOrder: 0,
      createdAt: CHECKED,
      updatedAt: CHECKED,
      syncStatus: 'synced',
    },
    {
      id: 'filipinas-nov-2026-ck-united-email',
      tripId: FILIPINAS_TRIP_ID,
      label: `United: correo primario verificado (${UNITED_PRIMARY_EMAIL}).`,
      status: 'done',
      sortOrder: 1,
      createdAt: UNITED_EMAIL_CHANGE,
      updatedAt: UNITED_EMAIL_CHANGE,
      syncStatus: 'synced',
    },
    {
      id: 'filipinas-nov-2026-ck-united-eticket',
      tripId: FILIPINAS_TRIP_ID,
      label:
        'United HNW4J6: reenviar eTicket/itinerario a Gmail; confirmar regreso 28 y asiento US$59.99.',
      status: 'open',
      sortOrder: 2,
      createdAt: UNITED_EMAIL_CHANGE,
      updatedAt: UNITED_EMAIL_CHANGE,
      syncStatus: 'synced',
    },
    {
      id: 'filipinas-nov-2026-ck-etravel',
      tripId: FILIPINAS_TRIP_ID,
      label:
        'eTravel F00NKZMH64BZ: llegada 17 nov 2026 UA809 MNL T3 (válido hasta 18 nov). QR en Docs.',
      status: 'done',
      sortOrder: 3,
      createdAt: UNITED_EMAIL_CHANGE,
      updatedAt: ETRAVEL_OK,
      syncStatus: 'synced',
    },
    {
      id: 'filipinas-nov-2026-ck-eni-shift',
      tripId: FILIPINAS_TRIP_ID,
      label:
        'Calendario interno alineado: Cebú 19–22, El Nido 22–25, Manila 25–28 (hotel 2ª vez pendiente).',
      status: 'done',
      sortOrder: 4,
      createdAt: KANSO_CHANGE,
      updatedAt: ETRAVEL_OK,
      syncStatus: 'synced',
    },
    {
      id: 'filipinas-nov-2026-ck-airbnb-refund',
      tripId: FILIPINAS_TRIP_ID,
      label:
        'Verificar reembolso Airbnb Kanso US$53.76 en VISA •4146 (modificación 15–19 → 17–19).',
      status: 'open',
      sortOrder: 5,
      createdAt: UNITED_EMAIL_CHANGE,
      updatedAt: UNITED_EMAIL_CHANGE,
      syncStatus: 'synced',
    },
    {
      id: 'filipinas-nov-2026-ck-insurance',
      tripId: FILIPINAS_TRIP_ID,
      label:
        'Intermundial TL-23267 Medium: vigencia 14–28 nov 2026 (PH + EE. UU.), 1 659,84 MXN — voucher descargado/OK.',
      status: 'done',
      sortOrder: 6,
      createdAt: UNITED_EMAIL_CHANGE,
      updatedAt: UNITED_EMAIL_CHANGE,
      syncStatus: 'synced',
    },
    {
      id: 'filipinas-nov-2026-ck-airbnb-cebu',
      tripId: FILIPINAS_TRIP_ID,
      label:
        'Airbnb Cebú Sleek Studio 19–22 nov: anotar código de confirmación y monto (recibo en Gmail).',
      status: 'open',
      sortOrder: 7,
      createdAt: UNITED_EMAIL_CHANGE,
      updatedAt: UNITED_EMAIL_CHANGE,
      syncStatus: 'synced',
    },
  ]

  const notes: Note[] = [
    {
      id: 'filipinas-nov-2026-nota',
      tripId: FILIPINAS_TRIP_ID,
      title: 'Itinerario elegido',
      body: 'Cadena: 16 nov UA822+UA809 → MNL 17 21:10 · 17–19 Kanso Makati · 19 5J 569 ZLW9UW + Sleek Studio Cebú · 22 DG6254 GWSE2U El Nido · 25 BG8LUF ENI→CEB→MNL · hotel Manila 25–28 (pendiente) · ~28 United HNW4J6. eTravel QR en Docs (F00NKZMH64BZ).',
      createdAt: CHECKED,
      updatedAt: ETRAVEL_OK,
      syncStatus: 'synced',
    },
    {
      id: 'filipinas-nov-2026-nota-united',
      tripId: FILIPINAS_TRIP_ID,
      title: 'Cuenta United',
      body: `Boleto HNW4J6 ya comprado. Correo primario del perfil verificado el 14 nov 2026: ${UNITED_PRIMARY_EMAIL}. Secundario: vantyc@hotmail.com. El eTicket aún no aparece en Gmail; reenviar itinerario a esta cuenta.`,
      createdAt: UNITED_EMAIL_CHANGE,
      updatedAt: UNITED_EMAIL_CHANGE,
      syncStatus: 'synced',
    },
  ]

  const packageImports: PackageImport[] = [
    {
      id: FILIPINAS_PACKAGE_ID,
      tripId: FILIPINAS_TRIP_ID,
      title: 'Filipinas noviembre 2026',
      importedAt: CHECKED,
      optionCount: travelOptions.length,
      schemaVersion: 1,
      revision: 5,
      generatedAt: ETRAVEL_OK,
    },
  ]

  return { trip, travelOptions, checklistItems, notes, packageImports }
}

/** Upsert eTravel QR into local Docs (Dexie). Cloud package v1 has no document blobs. */
export async function ensureFilipinasEtravelQr(documents: {
  get: (id: string) => Promise<{ id: string } | undefined>
  save: (
    meta: {
      id: string
      tripId: string
      name: string
      type: 'other'
      mimeType: string
      notes?: string
      capturedAt?: string
      syncStatus?: 'local' | 'synced'
    },
    blob: Blob,
  ) => Promise<unknown>
}): Promise<boolean> {
  const existing = await documents.get(FILIPINAS_ETRAVEL_DOC_ID)
  if (existing) return false
  const res = await fetch(FILIPINAS_ETRAVEL_QR_URL)
  if (!res.ok) {
    throw new Error(`No se pudo cargar el QR eTravel (${res.status}).`)
  }
  const blob = await res.blob()
  await documents.save(
    {
      id: FILIPINAS_ETRAVEL_DOC_ID,
      tripId: FILIPINAS_TRIP_ID,
      name: 'eTravel QR F00NKZMH64BZ — llegada 17 nov 2026 UA809.png',
      type: 'other',
      mimeType: 'image/png',
      notes:
        'Registro eTravel Filipinas. Llegada 17 nov 2026 · UA809 · MNL T3. Válido hasta 18 nov 2026. Ref F00NKZMH64BZ.',
      capturedAt: ETRAVEL_OK,
      syncStatus: 'local',
    },
    blob,
  )
  return true
}

/** Map seed bundle → TripPackage v1 (agent statuses only; booked stays PWA decisions). */
export function filipinasNov2026Package() {
  const bundle = filipinasNov2026Bundle()
  const pkgStatus = (s: string) =>
    s === 'shortlisted' || s === 'researched' ? s : 'shortlisted'
  return {
    schemaVersion: 1 as const,
    packageId: FILIPINAS_PACKAGE_ID,
    revision: bundle.packageImports[0]!.revision,
    generatedAt: bundle.packageImports[0]!.generatedAt,
    trip: {
      title: bundle.trip.title,
      destination: bundle.trip.destination,
      startDate: bundle.trip.startDate,
      endDate: bundle.trip.endDate,
      timezone: bundle.trip.timezone,
      goals: bundle.trip.goals,
      notes: bundle.trip.notes,
    },
    travelOptions: bundle.travelOptions.map((o) => ({
      externalId: o.externalId ?? o.id,
      type: o.type,
      status: pkgStatus(o.status) as 'researched' | 'shortlisted',
      title: o.title,
      provider: o.provider,
      startAt: o.startAt,
      endAt: o.endAt,
      origin: o.origin,
      destination: o.destination,
      address: o.address,
      phone: o.phone,
      priceObserved: o.priceObserved,
      currency: o.currency,
      sourceUrl: o.sourceUrl,
      checkedAt: o.checkedAt,
      verificationStatus: o.verificationStatus,
      sourceType: o.sourceType ?? 'cursor',
      notes: o.notes,
    })),
    checklistItems: bundle.checklistItems.map((c) => ({
      externalId: c.id,
      label: c.label,
      dueAt: c.dueAt,
      sortOrder: c.sortOrder,
    })),
    notes: bundle.notes.map((n) => ({
      externalId: n.id,
      title: n.title,
      body: n.body,
    })),
  }
}

/** Import Filipinas package into cloud SoT + attach eTravel QR in Docs. */
export async function seedFilipinasTrip(services: {
  packages: { importPackage: (raw: unknown) => Promise<unknown> }
  documents: {
    get: (id: string) => Promise<{ id: string } | undefined>
    save: (
      meta: {
        id: string
        tripId: string
        name: string
        type: 'other'
        mimeType: string
        notes?: string
        capturedAt?: string
        syncStatus?: 'local' | 'synced'
      },
      blob: Blob,
    ) => Promise<unknown>
  }
}): Promise<string> {
  await services.packages.importPackage(filipinasNov2026Package())
  await ensureFilipinasEtravelQr(services.documents)
  return FILIPINAS_TRIP_ID
}
