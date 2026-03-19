import { Badge } from '@/components/ui/badge';

export type LeadStatus =
  | 'new_lead'
  | 'in_qualification'
  | 'hot_lead'
  | 'qualified'
  | 'booked'
  | 'showed_up'
  | 'no_show'
  | 'closed'
  | 'serious_not_ready'
  | 'money_objection'
  | 'trust_objection'
  | 'ghosted'
  | 'unqualified';

const statusConfig: Record<LeadStatus, { label: string; className: string }> = {
  new_lead: {
    label: 'New Lead',
    className:
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800'
  },
  in_qualification: {
    label: 'In Qualification',
    className:
      'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800'
  },
  hot_lead: {
    label: 'Hot Lead',
    className:
      'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800'
  },
  qualified: {
    label: 'Qualified',
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
  },
  booked: {
    label: 'Booked',
    className:
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800'
  },
  showed_up: {
    label: 'Showed Up',
    className:
      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800'
  },
  no_show: {
    label: 'No Show',
    className:
      'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800'
  },
  closed: {
    label: 'Closed',
    className:
      'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800'
  },
  serious_not_ready: {
    label: 'Serious Not Ready',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800'
  },
  money_objection: {
    label: 'Money Objection',
    className:
      'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400 border-rose-200 dark:border-rose-800'
  },
  trust_objection: {
    label: 'Trust Objection',
    className:
      'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400 border-pink-200 dark:border-pink-800'
  },
  ghosted: {
    label: 'Ghosted',
    className:
      'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800'
  },
  unqualified: {
    label: 'Unqualified',
    className:
      'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400 border-slate-200 dark:border-slate-800'
  }
};

export const allStatuses = Object.entries(statusConfig).map(
  ([value, config]) => ({
    value: value as LeadStatus,
    label: config.label
  })
);

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const config = statusConfig[status];
  if (!config) return <Badge variant='outline'>{status}</Badge>;

  return (
    <Badge variant='outline' className={config.className}>
      {config.label}
    </Badge>
  );
}
