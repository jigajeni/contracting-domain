import { describe, it, expect } from 'vitest'
import { isoDate } from '@/domain/dates'
import {
  FAR_METRES, checkLocation, countByStage, distanceMetres, geotagStatus,
  stageFromTags, type Photo, type Point,
} from '@/domain/site/photos'

const JATH: Point = { lat: 17.0500, lng: 75.2100 }
/* The far end of MDR-42 — genuinely eight kilometres from the pin. */
const FAR_END: Point = { lat: 17.1200, lng: 75.2400 }
const PUNE: Point = { lat: 18.5204, lng: 73.8567 }

const photo = (over: Partial<Photo> = {}): Photo => ({
  id: 'p1', stage: 'before', takenAt: '2026-06-30T09:00:00Z',
  location: JATH, ...over,
})

describe('distance', () => {
  it('is zero for the same point', () => {
    expect(distanceMetres(JATH, JATH)).toBe(0)
  })

  it('measures the far end of a road in kilometres', () => {
    const m = distanceMetres(JATH, FAR_END)
    expect(m).toBeGreaterThan(7_000)
    expect(m).toBeLessThan(9_000)
  })
})

describe('where a photograph was taken', () => {
  it('accepts the far end of a linear work without complaint', () => {
    // A road spans kilometres and the project carries one pin. A tight radius
    // would flag honest work every day.
    const c = checkLocation(photo({ location: FAR_END }), JATH)
    expect(c.verdict).toBe('at_site')
    expect(c.message).toBeNull()
  })

  it('flags the gross error — a different taluka', () => {
    const c = checkLocation(photo({ location: PUNE }), JATH)
    expect(c.verdict).toBe('far')
    expect(c.metres).toBeGreaterThan(FAR_METRES)
    expect(c.message).toContain('km from this work')
  })

  it('calls a photograph with no coordinates unlocated, not merely unchecked', () => {
    const c = checkLocation(photo({ location: null }), JATH)
    expect(c.verdict).toBe('unlocated')
    expect(c.message).toContain('geo-tagged')
  })

  it('says so when the work itself has no coordinates', () => {
    expect(checkLocation(photo(), null).verdict).toBe('no_site_reference')
  })
})

describe('the geo-tag obligation', () => {
  const base = {
    required: true, uploadedOn: null, startDate: isoDate('2026-07-01'),
    site: JATH, today: isoDate('2026-09-15'),
  }

  it('is closed only by the portal upload being recorded', () => {
    const s = geotagStatus({ ...base, uploadedOn: isoDate('2026-06-28'),
      photos: [photo()] })
    expect(s.verdict).toBe('uploaded')
    expect(s.overdue).toBe(false)
    // The date comes back for the screen to format — never an ISO string in
    // a sentence. CLAUDE.md §0.4.
    expect(s.uploadedOn).toBe('2026-06-28')
    expect(s.message).not.toContain('2026')
  })

  it('is NOT closed by holding the photographs', () => {
    // The whole cost of the rule is in this distinction. A green tick here
    // would retire the reminder and leave the bill payable by us.
    const s = geotagStatus({ ...base, photos: [photo()] })
    expect(s.verdict).toBe('holding_evidence')
    expect(s.overdue).toBe(true)
    expect(s.usable).toBe(1)
    expect(s.message).toContain('separate act')
  })

  it('distinguishes photographs with no location from none at all', () => {
    const none = geotagStatus({ ...base, photos: [] })
    expect(none.verdict).toBe('nothing_on_file')

    const blind = geotagStatus({ ...base, photos: [photo({ location: null })] })
    expect(blind.verdict).toBe('none_before_start')
    expect(blind.usable).toBe(0)
    expect(blind.unlocated).toBe(1)
  })

  it('counts only before-work photographs towards it', () => {
    const s = geotagStatus({ ...base,
      photos: [photo({ stage: 'during' }), photo({ stage: 'after' })] })
    expect(s.verdict).toBe('nothing_on_file')
  })

  it('is overdue from the first day of work, not after a grace period', () => {
    expect(geotagStatus({ ...base, photos: [] }).overdue).toBe(true)
    expect(geotagStatus({ ...base, photos: [],
      startDate: isoDate('2026-10-01') }).overdue).toBe(false)
    expect(geotagStatus({ ...base, photos: [], startDate: null }).overdue).toBe(false)
  })

  it('says nothing where the department does not ask for it', () => {
    const s = geotagStatus({ ...base, required: false, photos: [] })
    expect(s.verdict).toBe('not_required')
    expect(s.overdue).toBe(false)
  })
})

describe('counting', () => {
  it('splits by stage', () => {
    const c = countByStage([photo(), photo({ stage: 'during' }), photo({ stage: 'during' })])
    expect(c).toEqual({ before: 1, during: 2, after: 0 })
  })
})

describe('reading the stage out of the tags', () => {
  it('finds the stage wherever it sits in the list', () => {
    // Real site photos carry a chainage and a structure too, and the stage is
    // rarely the first tag.
    expect(stageFromTags(['site photo', 'WMM', 'Km 8', 'before'])).toBe('before')
    expect(stageFromTags(['after'])).toBe('after')
  })

  it('never guesses "before", because an obligation rests on it', () => {
    expect(stageFromTags(['site photo', 'WMM', 'Km 8'])).toBe('during')
    expect(stageFromTags([])).toBe('during')
    expect(stageFromTags(null)).toBe('during')
  })
})
