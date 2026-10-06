/**
 * V2 — the shared score presentation.
 *
 * One place decides what a band is called and what colour it is, so the Leads table, the drawer and
 * the Journey tab cannot render the same lead differently. The thresholds themselves live in
 * journey.ts (scoreBand) and are asserted there; this file only chooses how they look.
 */
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { SCORE_BAND_LABEL, type ScoreBand } from '@/lib/journey'

/** Tailwind classes per band. Deliberately the same palette the rest of the app uses. */
const BAND_CLASS: Record<ScoreBand, string> = {
  cold: 'bg-destructive/15 text-destructive border-destructive/30',
  warming: 'bg-warning/15 text-warning border-warning/30',
  engaged: 'bg-info/15 text-info border-info/30',
  hot: 'bg-success/15 text-success border-success/30',
}

const BAND_DOT: Record<ScoreBand, string> = {
  cold: '🔴',
  warming: '🟡',
  engaged: '🟢',
  hot: '🔵',
}

export function ScoreBadge({
  score,
  band,
  showScore = true,
  className,
}: {
  score: number
  band: ScoreBand
  showScore?: boolean
  className?: string
}) {
  return (
    <Badge variant="outline" className={cn('gap-1 font-normal tabular-nums', BAND_CLASS[band], className)}>
      <span aria-hidden>{BAND_DOT[band]}</span>
      {showScore ? <span className="font-semibold">{score}</span> : null}
      <span>{SCORE_BAND_LABEL[band]}</span>
    </Badge>
  )
}

/** The literal dot, for places too small for a badge (e.g. a chart legend row). */
export function bandDot(band: ScoreBand): string {
  return BAND_DOT[band]
}

export { BAND_CLASS, BAND_DOT }
