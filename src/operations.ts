export type PublicationOperation = 'digest' | 'append' | 'retract';

export function publicationOperation(value?: string): PublicationOperation | undefined {
  if (value === 'publish') return 'digest';
  return value === 'digest' || value === 'append' || value === 'retract' ? value : undefined;
}

export const alertMutation = (value?: string) => ['alert', 'alert_retract', 'alert_confirm'].includes(value ?? '');
export const sourceMutation = (value?: string) => !!publicationOperation(value) || alertMutation(value) || value === 'event';
