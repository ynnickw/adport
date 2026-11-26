// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ActionPopover } from '@/components/action-popover';
import { Button, Input } from '@/components/controls';
import { Select } from '@/components/select';

afterEach(cleanup);

it('uses one anchored action panel with initial focus, Escape, and outside dismissal', () => {
  render(<><ActionPopover label="Manage Google Ads" triggerLabel="Manage">
    {close => <><Input data-autofocus aria-label="Connection nickname" /><Button type="button" onClick={close}>Done</Button></>}
  </ActionPopover><Button type="button">Outside</Button></>);
  const trigger = screen.getByRole('button', { name: 'Manage Google Ads' });
  fireEvent.click(trigger);
  const panel = screen.getByRole('dialog', { name: 'Manage Google Ads' });
  const input = within(panel).getByRole('textbox');
  expect(document.activeElement).toBe(input);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('uses listbox keyboard movement without submitting the form or choosing disabled options', () => {
  const { container } = render(<form><Select aria-label="Platform" name="platform" defaultValue="google" options={[
    { value: 'google', label: 'Google Ads' }, { value: 'meta', label: 'Meta Ads', disabled: true }, { value: 'apple', label: 'Apple Ads' },
  ]} /></form>);
  const trigger = screen.getByRole('combobox', { name: 'Platform: Google Ads' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const option = screen.getByRole('option', { name: 'Apple Ads' });
  expect(trigger.getAttribute('aria-activedescendant')).toBe(option.id);
  fireEvent.keyDown(trigger, { key: 'Enter' });
  expect(new FormData(container.querySelector('form')!).get('platform')).toBe('apple');
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.reset(container.querySelector('form')!);
  expect(screen.getByRole('combobox', { name: 'Platform: Google Ads' })).toBe(trigger);
});
