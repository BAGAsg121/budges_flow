import { LayoutDashboard, Users, BellRing, FileText, ScrollText, ShieldAlert } from 'lucide-react'

export type TabId = 'dashboard' | 'leads' | 'nudges' | 'templates' | 'logs' | 'failures'

export interface TabDef {
  id: TabId
  label: string
  icon: React.ElementType
  /** Shown in the page header, so every tab explains itself. */
  description: string
}

/**
 * Single source of truth for navigation, so the sidebar, the mobile drawer and the page
 * header can never disagree about a tab's label or its one-line description.
 */
export const TABS: TabDef[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    description: 'Delivery, opens and replies across every nudge.',
  },
  {
    id: 'leads',
    label: 'Leads',
    icon: Users,
    description: 'EPS leads synced from Zoho CRM, with their status and KYC progress.',
  },
  {
    id: 'nudges',
    label: 'Nudges',
    icon: BellRing,
    description: 'Every flow, which template it uses, and whether it is running.',
  },
  {
    id: 'templates',
    label: 'Templates',
    icon: FileText,
    description: 'WhatsApp templates and their Meta approval state, plus the email copy.',
  },
  {
    id: 'logs',
    label: 'Logs',
    icon: ScrollText,
    description: 'Every message sent, why any failed, and what customers replied.',
  },
  {
    id: 'failures',
    label: 'Failures',
    icon: ShieldAlert,
    description: 'Every failed delivery, with a one-click retry through its original nudge.',
  },
]

export function tabById(id: string): TabDef {
  return TABS.find((t) => t.id === id) ?? TABS[0]
}
