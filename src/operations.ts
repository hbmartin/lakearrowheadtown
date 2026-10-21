export type PublicationOperation = 'digest' | 'append' | 'retract';

export function publicationOperation(value?: string): PublicationOperation | undefined {
  if (value === 'publish') return 'digest';
  return value === 'digest' || value === 'append' || value === 'retract' ? value : undefined;
}
