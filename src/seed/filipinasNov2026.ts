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
const MNL_ENI =
  'https://www.kayak.com.mx/flights/MNL-ENI/2026-11-19?sort=duration_a'
const ENI_MNL =
  'https://www.kayak.com.mx/flights/ENI-MNL/2026-11-27?sort=duration_a'
const CRK_ENI =
  'https://www.kayak.com.mx/flights/CRK-ENI/2026-11-19?sort=price_a'
const ENI_CRK =
  'https://www.kayak.com.mx/flights/ENI-CRK/2026-11-27?sort=price_a'
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
      status: 'selected',
      budgetRole: 'primary',
      amountPaid: 0,
      title: 'United UA822 CDMX → San Francisco',
      provider: 'United',
      origin: 'MEX',
      destination: 'SFO',
      startAt: '2026-11-14T05:45:00-06:00',
      endAt: '2026-11-14T08:44:00-08:00',
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
        'Antes de pagar, confirmar que la maleta de 23 kg sigue en 13,105 MXN. No reservar.',
      notes:
        'Boleto MEX–SFO 14–28. Basic Economy son 11,238 MXN y solo incluyen un artículo personal. Con una maleta de 23 kg el boleto queda en 13,105. Economy con mano y asiento, misma consulta: 13,389, todavía sin esa maleta. La segunda maleta de este tramo quedó sin cotización. Hueco hasta UA809: 5 h 21 min. Cotizado, sin reserva ni pago.',
    }),
    row({
      id: 'filipinas-nov-2026-02-ua809',
      externalId: 'filipinas-nov-2026-02-ua809',
      type: 'flight',
      status: 'selected',
      budgetRole: 'primary',
      amountPaid: 0,
      title: 'United UA809 San Francisco → Manila',
      provider: 'United',
      origin: 'SFO',
      destination: 'MNL',
      startAt: '2026-11-14T14:05:00-08:00',
      endAt: '2026-11-15T21:10:00+08:00',
      priceObserved: 18523,
      sourceUrl: SFO_MNL_28,
      verificationStatus: 'verified',
      nextAction:
        'Al comprar, elegir pasillo. El asiento va incluido. No reservar.',
      notes:
        'Boleto SFO–MNL 14–28, directo, 15 h 05 min. Incluye dos maletas de 23 kg, una de mano y artículo personal. Asiento y cambios gratis, sin reembolso. El regreso UA190 va en el mismo boleto y no se suma otra vez. Cotizado, sin reserva ni pago.',
    }),
    row({
      id: 'filipinas-nov-2026-03-ua190',
      externalId: 'filipinas-nov-2026-03-ua190',
      type: 'flight',
      status: 'selected',
      budgetRole: 'primary',
      countsInBudget: false,
      amountPaid: 0,
      title: 'Regreso United UA190 Manila → San Francisco',
      provider: 'United',
      origin: 'MNL',
      destination: 'SFO',
      startAt: '2026-11-28T09:55:00+08:00',
      endAt: '2026-11-28T06:35:00-08:00',
      priceObserved: 18523,
      sourceUrl: SFO_MNL_28,
      verificationStatus: 'verified',
      nextAction:
        'Confirmar que el hueco hasta UA817 sigue en 6 h 39 min. No reservar.',
      notes:
        'Mismo boleto que UA809, 18,523 MXN. No se suma otra vez. Directo, 12 h 40 min. Sale de Manila el sábado 28 a las 09:55.',
    }),
    row({
      id: 'filipinas-nov-2026-04-ua817',
      externalId: 'filipinas-nov-2026-04-ua817',
      type: 'flight',
      status: 'selected',
      budgetRole: 'primary',
      countsInBudget: false,
      amountPaid: 0,
      title: 'Regreso United UA817 San Francisco → CDMX',
      provider: 'United',
      origin: 'SFO',
      destination: 'MEX',
      startAt: '2026-11-28T13:14:00-08:00',
      endAt: '2026-11-28T19:35:00-06:00',
      priceObserved: 13105,
      sourceUrl: MEX_SFO_28,
      verificationStatus: 'verified',
      nextAction: 'Llegada elegida a CDMX: sábado 28 a las 19:35. No reservar.',
      notes:
        'Mismo boleto que UA822, 13,105 MXN con una maleta de 23 kg. No se suma otra vez. Aterriza en CDMX el sábado 28 a las 19:35.',
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
      id: 'filipinas-nov-2026-p-mnl-eni-ceb',
      externalId: 'filipinas-nov-2026-p-mnl-eni-ceb',
      type: 'flight',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — Manila → El Nido vía Cebu, 19 nov 2026',
      provider: 'Cebu Pacific',
      origin: 'MNL',
      destination: 'ENI',
      sourceUrl: MNL_ENI,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction:
        'Cotizar en MXN, con maleta, y anotar si los dos tramos van en un solo boleto.',
      notes:
        'Sin cotización en esta carga. Evitar autobús, van compartida y lancha. La búsqueda es Manila–El Nido el 19 de noviembre (traslado movido: Airbnb Makati queda hasta el 19).',
    }),
    row({
      id: 'filipinas-nov-2026-p-eni-mnl-ceb',
      externalId: 'filipinas-nov-2026-p-eni-mnl-ceb',
      type: 'flight',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — El Nido → Manila vía Cebu, 27 nov 2026',
      provider: 'Cebu Pacific',
      origin: 'ENI',
      destination: 'MNL',
      sourceUrl: ENI_MNL,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction:
        'Cotizar el regreso del 27 para dormir esa noche y la siguiente en Manila.',
      notes:
        'Sin cotización en esta carga. Tiene que dejar la noche del 27 en Manila antes del internacional del 28.',
    }),
    row({
      id: 'filipinas-nov-2026-p-crk-eni',
      externalId: 'filipinas-nov-2026-p-crk-eni',
      type: 'flight',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — Clark → El Nido directo, 19 nov 2026',
      provider: 'Cebgo',
      origin: 'CRK',
      destination: 'ENI',
      sourceUrl: CRK_ENI,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction: 'Cotizar el directo y cruzarlo con el auto privado Manila–Clark.',
      notes:
        'Sin cotización en esta carga. Es la otra ruta, separada de la de Cebu. Fecha movida al 19 por el Airbnb Makati 17–19.',
    }),
    row({
      id: 'filipinas-nov-2026-p-eni-crk',
      externalId: 'filipinas-nov-2026-p-eni-crk',
      type: 'flight',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — El Nido → Clark directo, 27 nov 2026',
      provider: 'Cebgo',
      origin: 'ENI',
      destination: 'CRK',
      sourceUrl: ENI_CRK,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction: 'Cotizar el directo del 27 y el auto Clark–Manila de esa noche.',
      notes: 'Sin cotización en esta carga.',
    }),
    row({
      id: 'filipinas-nov-2026-p-car-mnl-crk',
      externalId: 'filipinas-nov-2026-p-car-mnl-crk',
      type: 'transfer',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — auto privado Manila → Clark, 19 nov 2026',
      origin: 'Manila',
      destination: 'CRK',
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction: 'Cotizar sedan privado para el 19. Sin autobús ni van compartida.',
      notes:
        'Sin cotización para esa fecha. No usar una tarifa publicada de otro día. Sale tras el check-out de Kanso (19 nov).',
    }),
    row({
      id: 'filipinas-nov-2026-p-car-crk-mnl',
      externalId: 'filipinas-nov-2026-p-car-crk-mnl',
      type: 'transfer',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — auto privado Clark → Manila, 27 nov 2026',
      origin: 'CRK',
      destination: 'Manila',
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction: 'Cotizar sedan privado del 27 para llegar al hotel de Manila.',
      notes: 'Sin cotización para esa fecha.',
    }),
    row({
      id: 'filipinas-nov-2026-p-hotel-mnl-15',
      externalId: 'filipinas-nov-2026-p-hotel-mnl-15',
      type: 'lodging',
      status: 'booked',
      budgetRole: 'primary',
      amountPaid: 0,
      title: 'Airbnb Kanso 簡素 Makati Home, 17 al 19 nov 2026',
      provider: 'Airbnb — Abyzz y Gavt',
      destination: 'Makati',
      address: 'Makati, Metro Manila',
      startAt: '2026-11-17T15:00:00+08:00',
      endAt: '2026-11-19T11:00:00+08:00',
      checkedAt: KANSO_CHANGE,
      verificationStatus: 'verified',
      currency: undefined,
      nextAction:
        'Check-in autónomo ~23:00 ok. Instrucciones (caja de llaves) llegan un día antes. Otro cambio de fecha = política de cancelación estándar.',
      notes:
        'Cambio de fecha autorizado por Abyzz y Gavt el 14 nov 2026 como cortesía única (cancelaciones de vuelos). Reserva Airbnb: 17–19 nov. Antes la ventana investigada era 15–17 (Seda/Okura). Seda: ' +
        SEDA +
        `. Okura: ${OKURA}.`,
    }),
    row({
      id: 'filipinas-nov-2026-p-hotel-mnl-27',
      externalId: 'filipinas-nov-2026-p-hotel-mnl-27',
      type: 'lodging',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — hotel en Manila, 27 al 28 nov 2026',
      provider: 'Seda BGC',
      destination: 'Manila',
      address: 'Bonifacio Global City, Taguig',
      startAt: '2026-11-27T15:00:00+08:00',
      endAt: '2026-11-28T07:00:00+08:00',
      sourceUrl: SEDA,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction:
        'Cotizar la noche del 27, con salida el 28 antes de UA190 a las 09:55.',
      notes: `Una noche. El vuelo internacional sale de Manila el 28 a las 09:55. Okura: ${OKURA}. Sin cotización.`,
    }),
    row({
      id: 'filipinas-nov-2026-p-hotel-eni',
      externalId: 'filipinas-nov-2026-p-hotel-eni',
      type: 'lodging',
      status: 'researched',
      budgetRole: 'pending',
      title: 'Pendiente — hotel en El Nido, 19 al 27 nov 2026',
      provider: 'Huni Lio',
      destination: 'El Nido',
      startAt: '2026-11-19T15:00:00+08:00',
      endAt: '2026-11-27T11:00:00+08:00',
      sourceUrl: HUNI,
      verificationStatus: 'unverified',
      currency: undefined,
      nextAction:
        'Cotizar Huni Lio y Seda Lio, total con impuestos y cancelación, del 19 al 27.',
      notes: `Ocho noches (antes diez: 17–27). Ventana recortada porque Airbnb Makati queda hasta el 19. Habitación privada con aire. Seda Lio: ${SEDA_LIO}. Sin cotización.`,
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
    destination: 'Manila y El Nido',
    startDate: '2026-11-14',
    endDate: '2026-11-29',
    timezone: 'America/Mexico_City',
    goals: [
      { id: 'filipinas-meta-noches', label: 'Manila y después El Nido' },
      {
        id: 'filipinas-meta-regreso',
        label: 'Salir de CDMX el 14 y estar de vuelta a más tardar el 29',
      },
    ],
    status: 'planned',
    notes:
      'Opción provisional: dos boletos United por San Francisco. Salida de CDMX el 14 nov 2026 y regreso el 28 a las 19:35. Subtotal 31,628 MXN con una maleta de 23 kg en el tramo corto. El boleto único de 40,886 MXN queda como alternativa. Cotizado el 3 nov 2026 en Skyscanner México. Airbnb Kanso Makati confirmado 17–19 (cambio de fecha autorizado 14 nov). El Nido y traslados internos replanificados al 19. Las búsquedas nuevas de este viaje se guardan en este mismo registro.',
    createdAt: CHECKED,
    updatedAt: KANSO_CHANGE,
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
      id: 'filipinas-nov-2026-ck-eni-shift',
      tripId: FILIPINAS_TRIP_ID,
      label:
        'Replanificar El Nido y vuelos internos al 19 nov (Airbnb Makati 17–19 autorizado). Cotizar hotel 19–27 y MNL/CRK→ENI del 19.',
      status: 'open',
      sortOrder: 1,
      createdAt: KANSO_CHANGE,
      updatedAt: KANSO_CHANGE,
      syncStatus: 'synced',
    },
    {
      id: 'filipinas-nov-2026-ck-gap-15',
      tripId: FILIPINAS_TRIP_ID,
      label:
        'Si UA809 sigue llegando el 15: cubrir noches 15–16 en Manila (Kanso empieza el 17) o confirmar el nuevo arribo.',
      status: 'open',
      sortOrder: 2,
      createdAt: KANSO_CHANGE,
      updatedAt: KANSO_CHANGE,
      syncStatus: 'synced',
    },
  ]

  const notes: Note[] = [
    {
      id: 'filipinas-nov-2026-nota',
      tripId: FILIPINAS_TRIP_ID,
      title: 'Itinerario elegido',
      body: '14 nov 05:45 UA822 MEX→SFO 08:44. 14:05 UA809 SFO→MNL 21:10 del 15. Airbnb Kanso Makati 17–19 (cambio autorizado 14 nov por Abyzz/Gavt; check-in ~23:00 ok). El Nido 19–27, Manila 27–28. 28 nov 09:55 UA190 MNL→SFO 06:35 y 13:14 UA817 SFO→MEX 19:35. Dos boletos, sin protección entre sí. Internos y El Nido aún sin reservar.',
      createdAt: CHECKED,
      updatedAt: KANSO_CHANGE,
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
      revision: 2,
      generatedAt: KANSO_CHANGE,
    },
  ]

  return { trip, travelOptions, checklistItems, notes, packageImports }
}
