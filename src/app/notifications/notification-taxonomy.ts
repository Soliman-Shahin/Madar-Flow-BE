export const NOTIFICATION_CATEGORIES = [
  'sync',
  'subscription',
  'security',
  'general',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ['inbox', 'realtime', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_EVENTS = [
  'sync.conflict',
  'sync.repeated_failure',
  'subscription.expiring',
  'security.new_login',
  'security.session_limit',
  'general.admin_broadcast',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export type NotificationPolicy = 'optional' | 'mandatory';

export const NOTIFICATION_EVENT_DEFINITIONS: Record<
  NotificationEvent,
  { category: NotificationCategory; policy: NotificationPolicy }
> = {
  'sync.conflict': { category: 'sync', policy: 'optional' },
  'sync.repeated_failure': { category: 'sync', policy: 'optional' },
  'subscription.expiring': { category: 'subscription', policy: 'optional' },
  'security.new_login': { category: 'security', policy: 'mandatory' },
  'security.session_limit': { category: 'security', policy: 'mandatory' },
  'general.admin_broadcast': { category: 'general', policy: 'mandatory' },
};

export function definitionForEvent(event: string) {
  const definition = NOTIFICATION_EVENT_DEFINITIONS[event as NotificationEvent];
  if (!definition) throw new Error('UNKNOWN_NOTIFICATION_EVENT');
  return definition;
}

export interface NotificationPreferenceChannels {
  inbox: boolean;
  realtime: boolean;
  push: boolean;
}

export type NotificationPreferences = Record<
  NotificationCategory,
  NotificationPreferenceChannels
>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  sync: { inbox: true, realtime: true, push: true },
  subscription: { inbox: true, realtime: true, push: true },
  security: { inbox: true, realtime: true, push: true },
  general: { inbox: true, realtime: true, push: true },
};

export function channelsForPolicy(
  category: NotificationCategory,
  policy: NotificationPolicy,
  preferences: NotificationPreferences
): NotificationChannel[] {
  if (policy === 'mandatory') return [...NOTIFICATION_CHANNELS];
  return NOTIFICATION_CHANNELS.filter(
    (channel) => preferences[category][channel]
  );
}
