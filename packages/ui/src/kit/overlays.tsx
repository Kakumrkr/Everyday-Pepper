'use client';

import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixTabs from '@radix-ui/react-tabs';
import * as RadixToast from '@radix-ui/react-toast';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import type { ReactNode } from 'react';
import { cx } from '../class-names.js';
import { FOCUS_RING, IconButton } from './button.js';

// The kit's pieces that need focus or overlay behaviour (DESIGN.md §4), on Radix primitives
// (ADR-0044): they keep focus inside, close on Escape and return focus to the trigger.

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  /** The button that opens it, if it has one on the page. */
  trigger?: ReactNode;
  children: ReactNode;
  /** The sheet's actions, at the bottom within thumb reach (D3). */
  footer?: ReactNode;
}

const OVERLAY = 'fixed inset-0 z-40 bg-scrim animate-fade-in';

function Header({ title, description }: { title: string; description?: string | undefined }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <RadixDialog.Title className="m-0 type-title text-ink">{title}</RadixDialog.Title>
        {description !== undefined && (
          <RadixDialog.Description className="m-0 mt-1 type-body text-ink-2">
            {description}
          </RadixDialog.Description>
        )}
      </div>
      <RadixDialog.Close asChild>
        <IconButton icon="close" label="Close" className="-mt-1 -mr-2" />
      </RadixDialog.Close>
    </div>
  );
}

/** A bottom sheet on phones (an approval, a booking); centred from 960 px. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
}: OverlayProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger !== undefined && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY} />
        <RadixDialog.Content
          {...(description === undefined && { 'aria-describedby': undefined })}
          className={cx(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col gap-4 rounded-t-xl bg-surface px-5 pt-5',
            'pb-[max(1.25rem,env(safe-area-inset-bottom))] text-ink shadow-floating animate-sheet-in',
            'desk:inset-x-auto desk:top-1/2 desk:bottom-auto desk:left-1/2 desk:w-[34rem]',
            'desk:-translate-x-1/2 desk:-translate-y-1/2 desk:rounded-xl desk:animate-fade-in',
          )}
        >
          <div
            aria-hidden="true"
            className="mx-auto -mt-2 h-1 w-10 rounded-pill bg-line desk:hidden"
          />
          <Header title={title} description={description} />
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer !== undefined && <div className="flex flex-col gap-2">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A centred dialog for a short question ("Delete this service?"). */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
}: OverlayProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger !== undefined && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY} />
        <RadixDialog.Content
          {...(description === undefined && { 'aria-describedby': undefined })}
          className={cx(
            'fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2.5rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
            'flex-col gap-4 rounded-lg bg-surface p-5 text-ink shadow-floating animate-fade-in',
          )}
        >
          <Header title={title} description={description} />
          {children}
          {footer !== undefined && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export interface TabPanel {
  value: string;
  label: string;
  content: ReactNode;
}

/** Tabs over panels of one screen (a client's Visits · What I know); arrow keys move along. */
export function Tabs({
  label,
  tabs,
  value,
  onValueChange,
  defaultValue,
}: {
  label: string;
  tabs: readonly TabPanel[];
  value?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  defaultValue?: string | undefined;
}) {
  return (
    <RadixTabs.Root
      {...(value !== undefined && { value })}
      {...(onValueChange !== undefined && { onValueChange })}
      defaultValue={defaultValue ?? tabs[0]?.value}
      className="flex flex-col gap-4"
    >
      <RadixTabs.List aria-label={label} className="flex gap-1 border-b border-line">
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.value}
            value={tab.value}
            className={cx(
              '-mb-px min-h-11 rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 py-0 type-label text-ink-2',
              'transition motion-fast ease-standard hover:text-ink',
              'data-[state=active]:border-brand data-[state=active]:text-ink',
              FOCUS_RING,
            )}
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((tab) => (
        <RadixTabs.Content key={tab.value} value={tab.value} className={FOCUS_RING}>
          {tab.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

export interface SegmentOption {
  value: string;
  label: string;
}

/** A choice of one view (Both / Dre / Randy): a pill track, the chosen option raised. */
export function Segmented({
  label,
  options,
  value,
  onValueChange,
}: {
  label: string;
  options: readonly SegmentOption[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      // Pressing the chosen option again would clear it; a segmented control always has one.
      onValueChange={(next) => {
        if (next !== '') onValueChange(next);
      }}
      className="inline-flex gap-1 rounded-pill bg-surface-2 p-1"
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className={cx(
            'min-h-11 flex-1 rounded-pill bg-transparent px-4 py-0 type-label whitespace-nowrap text-ink-2',
            'transition motion-base ease-standard hover:text-ink',
            'data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-raised',
            FOCUS_RING,
          )}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/** Wraps the app once: where toasts appear (above the bottom tabs on phones). */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <RadixToast.Provider swipeDirection="down" duration={6000}>
      {children}
      <RadixToast.Viewport
        className={cx(
          'fixed inset-x-0 bottom-0 z-50 m-0 flex list-none flex-col gap-2 p-4',
          // Above the bottom tabs, whose height grows by the phone's safe area.
          'pb-[calc(5rem+env(safe-area-inset-bottom))]',
          'desk:inset-x-auto desk:right-6 desk:bottom-6 desk:w-96 desk:p-0',
        )}
      />
    </RadixToast.Provider>
  );
}

/** A short note about something that just happened, with one action (usually Undo). */
export function Toast({
  open,
  onOpenChange,
  title,
  action,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  action?: { label: string; altText: string; onClick: () => void } | undefined;
}) {
  return (
    <RadixToast.Root
      open={open}
      onOpenChange={onOpenChange}
      className="flex items-center gap-3 rounded-lg bg-ink px-4 py-3 text-bg shadow-floating animate-fade-in"
    >
      <RadixToast.Title className="flex-1 type-body">{title}</RadixToast.Title>
      {action !== undefined && (
        <RadixToast.Action
          altText={action.altText}
          onClick={action.onClick}
          className={cx(
            'min-h-11 shrink-0 rounded-pill bg-transparent px-3 py-0 type-label text-bg underline underline-offset-2',
            // The ring in the page color: the toast is ink, where `brand` would be too faint.
            'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-bg',
          )}
        >
          {action.label}
        </RadixToast.Action>
      )}
    </RadixToast.Root>
  );
}
