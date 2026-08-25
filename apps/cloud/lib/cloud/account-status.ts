export interface AccountStatusPresentation {
  label: string;
  tone: '' | 'neutral';
}

export function accountStatusPresentation(status?: string): AccountStatusPresentation {
  if (!status) return { label: 'Available', tone: '' };

  const indeterminate = status.match(/^(UNKNOWN|UNSPECIFIED)( \(manager\))?$/i);
  if (indeterminate) {
    return {
      label: `Status unavailable${indeterminate[2] ?? ''}`,
      tone: 'neutral',
    };
  }

  return {
    label: status,
    tone: /paused|disabled|removed|inactive/i.test(status) ? 'neutral' : '',
  };
}
