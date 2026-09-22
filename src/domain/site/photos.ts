import type { ISODate } from '../dates'

/**
 * Site photographs, and the difference between having them and being covered.
 *
 * A photograph is the cheapest evidence on a construction file and the one
 * most often missing when it is needed. Three separate obligations rest on it:
 *
 *  - **Geo-tagged photographs before work starts**, uploaded to the
 *    departmental portal. CLAUDE.md §3 `GEOTAG_UPLOAD`: miss it and the bill
 *    for that work becomes our own liability.
 *  - **Before-and-after photographs with the bill.** The Dalit Vasti scrutiny
 *    sheet lists them among the twenty-four papers a BDO wants before the
 *    proposal is accepted at all.
 *  - **What the work actually looked like** on a day now argued about.
 *
 * The first two are checkable and this module checks them. What it refuses to
 * do is confuse *we hold photographs* with *we have complied* — the portal
 * upload is a separate act performed on a different system, and a screen that
 * ticked itself off when a file landed here would close the alert that exists
 * to prevent the loss.
 *
 * Pure. CLAUDE.md §5.
 */

export type Stage = 'before' | 'during' | 'after'

export const STAGE_LABEL: Record<Stage, string> = {
  before: 'Before work',
  during: 'In progress',
  after: 'After completion',
}

export const STAGES: readonly Stage[] = ['before', 'during', 'after'] as const

/**
 * The stage a photograph belongs to, read out of its tags.
 *
 * Tags are a free list and site photographs carry others — a chainage, a
 * structure, the word "site photo" itself. Taking the first tag as the stage
 * reads whichever happened to be typed first, so the stage is looked for by
 * name and anything unrecognised falls back to `during`: a photograph of work
 * in progress is the safe assumption, and `before` is the one that must never
 * be assumed, because it is the one an obligation rests on.
 */
export function stageFromTags(tags: readonly string[] | null | undefined): Stage {
  return (tags ?? []).find((t): t is Stage =>
    (STAGES as readonly string[]).includes(t)) ?? 'during'
}

export interface Point { lat: number; lng: number }

export interface Photo {
  id: string
  stage: Stage
  takenAt: string | null
  location: Point | null
  takenOn?: ISODate | null
}

/* ------------------------------------------------------------------ */
/* Where it was taken                                                  */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_M = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180

/** Great-circle distance in metres. */
export function distanceMetres(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * How far a photograph may be from the pin before it is worth mentioning.
 *
 * Deliberately huge. A project carries one coordinate and a road does not —
 * MDR-42 runs from Km 4/000 to Km 12/500, so a photograph of its far end is
 * eight kilometres from the pin and perfectly genuine. A tight radius would
 * flag honest work every day, and a check that cries wolf daily is switched
 * off within a week.
 *
 * So this catches only the gross error worth catching: the photograph taken at
 * the office, or at a different site in the next taluka, and filed here.
 */
export const FAR_METRES = 25_000

export type LocationVerdict =
  /** No coordinates at all. Not a geo-tagged photograph, whatever it shows. */
  | 'unlocated'
  /** Located, but the work has no coordinate to compare it against. */
  | 'no_site_reference'
  | 'at_site'
  | 'far'

export interface LocationCheck {
  verdict: LocationVerdict
  metres: number | null
  message: string | null
}

export function checkLocation(photo: Photo, site: Point | null): LocationCheck {
  if (!photo.location) {
    return { verdict: 'unlocated', metres: null,
      message: 'No location recorded. The department asks for geo-tagged '
        + 'photographs — this one will not satisfy that, whatever it shows.' }
  }
  if (!site) {
    return { verdict: 'no_site_reference', metres: null,
      message: 'This work has no coordinates recorded, so there is nothing to '
        + 'check the location against.' }
  }
  const metres = Math.round(distanceMetres(photo.location, site))
  if (metres > FAR_METRES) {
    return { verdict: 'far', metres,
      message: `Taken ${(metres / 1000).toFixed(1)} km from this work. Check it `
        + 'is filed against the right site.' }
  }
  return { verdict: 'at_site', metres, message: null }
}

/* ------------------------------------------------------------------ */
/* Whether the obligation is met                                       */
/* ------------------------------------------------------------------ */

export interface GeotagInput {
  /** Whether this work's department demands the portal upload at all. */
  required: boolean
  /** The date the office recorded the portal upload. Null means not done. */
  uploadedOn: ISODate | null
  /** When work started or is due to start. Null where no date is set. */
  startDate: ISODate | null
  photos: Photo[]
  site: Point | null
  today: ISODate
}

export type GeotagVerdict =
  | 'not_required'
  | 'uploaded'
  /** Photographs on file, portal upload not recorded. */
  | 'holding_evidence'
  /** Located photographs exist but none are from before work started. */
  | 'none_before_start'
  | 'nothing_on_file'

export interface GeotagStatus {
  verdict: GeotagVerdict
  /** The recorded portal-upload date, for the screen to format. */
  uploadedOn: ISODate | null
  /** Before-work photographs that actually carry coordinates. */
  usable: number
  /** Before-work photographs with no coordinates — evidence of nothing. */
  unlocated: number
  overdue: boolean
  message: string
}

/**
 * Whether the geo-tag obligation is covered.
 *
 * `uploaded` is the ONLY verdict that closes it, and it comes from the office
 * recording the portal upload — never from a file arriving here. Holding the
 * photographs is a precondition for complying, not compliance, and the whole
 * cost of the rule falls on that distinction: a screen that went green when a
 * photo landed would retire the reminder and leave the bill payable by us.
 */
export function geotagStatus(input: GeotagInput): GeotagStatus {
  const before = input.photos.filter((p) => p.stage === 'before')
  const usable = before.filter(
    (p) => checkLocation(p, input.site).verdict !== 'unlocated').length
  const unlocated = before.length - usable

  if (!input.required) {
    return { verdict: 'not_required', uploadedOn: null, usable, unlocated,
      overdue: false,
      message: 'This work does not require the portal upload.' }
  }
  if (input.uploadedOn) {
    /* The date is returned, not formatted in. A domain module has no business
       deciding how a date reads — CLAUDE.md §0.4 wants DD-MM-YYYY on screen,
       and a message built here arrives as a raw ISO string. */
    return { verdict: 'uploaded', uploadedOn: input.uploadedOn, usable,
      unlocated, overdue: false, message: 'Uploaded to the portal' }
  }

  /* Overdue the moment work has started, not on some grace period: the rule
     is that the photographs go up BEFORE the first day. */
  const overdue = input.startDate !== null && input.startDate <= input.today

  if (before.length === 0) {
    return { verdict: 'nothing_on_file', uploadedOn: null, usable, unlocated, overdue,
      message: 'No before-work photographs on file. Until the portal upload is '
        + 'done the bill for this work is our own liability.' }
  }
  if (usable === 0) {
    return { verdict: 'none_before_start', uploadedOn: null, usable, unlocated, overdue,
      message: `${before.length} before-work photograph`
        + `${before.length > 1 ? 's, none of which carry' : ' which does not carry'}`
        + ' a location. The department asks for geo-tagged photographs.' }
  }
  return { verdict: 'holding_evidence', uploadedOn: null, usable, unlocated, overdue,
    message: `${usable} geo-tagged before-work photograph${usable > 1 ? 's' : ''} `
      + 'on file. The portal upload is a separate act and is not recorded yet.' }
}

/** How many photographs exist at each stage. */
export function countByStage(photos: Photo[]): Record<Stage, number> {
  return {
    before: photos.filter((p) => p.stage === 'before').length,
    during: photos.filter((p) => p.stage === 'during').length,
    after: photos.filter((p) => p.stage === 'after').length,
  }
}
