'use client';

import {
  MAX_GALLERY_PHOTOS,
  MAX_PHOTO_CAPTION_LENGTH,
  BusinessPhotoSchema,
  type BusinessPhoto,
  type BusinessPhotoKind,
  type BusinessPhotos,
  type PublicPhoto,
} from '@pepper/contracts';
import { Button, Input } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import {
  ACCEPTED_PHOTO_TYPES,
  photoAlt,
  photoSrc,
  precheckPhoto,
  uploadPhoto,
} from '../../../lib/photos';
import { Notice } from '../form-parts';
import { PhotoImage } from '../photo-image';

type Message = { tone: 'ok' | 'error'; text: string } | null;

/**
 * The booking page's photos (S47.2, ADR-0048, AC-W8-10/11), for owners and managers on the
 * Services screen: a logo, a cover and up to 12 photos of their work, each checked and resized
 * by the api. A quiet section like the booking page's card: nothing here waits on a decision.
 */
export function PhotosCard({
  slug,
  businessName,
  initial,
}: {
  slug: string;
  businessName: string;
  /** `null`: they couldn't be loaded. */
  initial: BusinessPhotos | null;
}) {
  const router = useRouter();
  const [photos, setPhotos] = useState<BusinessPhotos | null>(initial);
  const headingId = useId();

  if (photos === null) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <h2 id={headingId} className="m-0 type-heading">
          Photos
        </h2>
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load your photos. Try again in a moment.
        </p>
      </section>
    );
  }

  const added = (photo: BusinessPhoto) => {
    setPhotos((current) => {
      if (current === null) return current;
      if (photo.kind === 'gallery') return { ...current, gallery: [...current.gallery, photo] };
      return { ...current, [photo.kind]: photo };
    });
  };
  const removed = (kind: BusinessPhotoKind, id: string) => {
    setPhotos((current) => {
      if (current === null) return current;
      if (kind === 'gallery') {
        return { ...current, gallery: current.gallery.filter((photo) => photo.id !== id) };
      }
      return { ...current, [kind]: null };
    });
    router.refresh();
  };

  return (
    <section
      id="photos"
      aria-labelledby={headingId}
      className="flex scroll-mt-4 flex-col gap-3"
      data-testid="photos-card"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="m-0 type-heading">
          Photos
        </h2>
        <p className="m-0 type-body text-ink-2">
          Show clients your place and your work. They appear on your booking page.
        </p>
      </div>
      <div className="flex flex-col divide-y divide-line rounded-lg bg-surface px-4">
        <SinglePhoto
          kind="logo"
          title="Logo"
          hint="Beside your name. Square works best, at least 128 px."
          slug={slug}
          businessName={businessName}
          photo={photos.logo}
          onAdded={added}
          onRemoved={removed}
        />
        <SinglePhoto
          kind="cover"
          title="Cover photo"
          hint="Across the top of your page: your chair, your shop front. At least 600 px."
          slug={slug}
          businessName={businessName}
          photo={photos.cover}
          onAdded={added}
          onRemoved={removed}
        />
        <Gallery
          slug={slug}
          businessName={businessName}
          photos={photos.gallery}
          onAdded={added}
          onRemoved={removed}
        />
      </div>
    </section>
  );
}

/** A hidden file picker and the upload it starts; `pick()` opens it. */
function usePicker(
  kind: BusinessPhotoKind,
  onAdded: (photo: BusinessPhoto) => void,
  setMessage: (message: Message) => void,
) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function send(files: File[]): Promise<void> {
    setMessage(null);
    try {
      await sendAll(files);
    } finally {
      // Once per batch: the page behind the card (and Home) shows the photos now stored.
      router.refresh();
    }
  }

  async function sendAll(files: File[]): Promise<void> {
    for (const file of files) {
      const refused = precheckPhoto(file);
      if (refused !== null) {
        setMessage({ tone: 'error', text: refused });
        return;
      }
      setBusy(true);
      const answer = await uploadPhoto(kind, file);
      setBusy(false);
      if (!answer.ok) {
        setMessage({ tone: 'error', text: answer.message });
        return;
      }
      onAdded(answer.data);
    }
    setMessage({ tone: 'ok', text: 'Added. Clients see it on your booking page.' });
  }

  const element = (
    <input
      ref={input}
      type="file"
      accept={ACCEPTED_PHOTO_TYPES}
      multiple={kind === 'gallery'}
      hidden
      data-testid={`photo-input-${kind}`}
      onChange={(event) => {
        const files = [...(event.target.files ?? [])];
        event.target.value = '';
        if (files.length > 0) void send(files);
      }}
    />
  );
  return { element, busy, pick: () => input.current?.click() };
}

function useRemove(
  kind: BusinessPhotoKind,
  onRemoved: (kind: BusinessPhotoKind, id: string) => void,
  setMessage: (message: Message) => void,
) {
  const [busyId, setBusyId] = useState<string | null>(null);
  async function remove(id: string): Promise<void> {
    setMessage(null);
    setBusyId(id);
    const answer = await sendJson(
      'DELETE',
      `/v1/tenant/photos/${encodeURIComponent(id)}`,
      undefined,
    );
    setBusyId(null);
    // Already gone counts as removed: the page shows what is stored.
    if (!answer.ok && answer.status !== 404) {
      setMessage({ tone: 'error', text: answer.message });
      return;
    }
    onRemoved(kind, id);
    setMessage({ tone: 'ok', text: 'Removed from your booking page.' });
  }
  return { busyId, remove };
}

function SinglePhoto({
  kind,
  title,
  hint,
  slug,
  businessName,
  photo,
  onAdded,
  onRemoved,
}: {
  kind: 'logo' | 'cover';
  title: string;
  hint: string;
  slug: string;
  businessName: string;
  photo: PublicPhoto | null;
  onAdded: (photo: BusinessPhoto) => void;
  onRemoved: (kind: BusinessPhotoKind, id: string) => void;
}) {
  const [message, setMessage] = useState<Message>(null);
  const picker = usePicker(kind, onAdded, setMessage);
  const remover = useRemove(kind, onRemoved, setMessage);
  const frame = kind === 'logo' ? 'size-16 rounded-pill' : 'h-16 w-28 rounded-md';
  return (
    <div className="flex flex-col gap-3 py-4" data-testid={`photo-${kind}`}>
      <div className="flex items-center gap-3">
        {photo === null ? (
          <span aria-hidden="true" className={`${frame} shrink-0 bg-surface-2`} />
        ) : (
          <PhotoImage
            src={photoSrc(slug, photo, kind === 'logo' ? 128 : 320)}
            alt={photoAlt(photo, kind, businessName)}
            width={photo.width}
            height={photo.height}
            className={`${frame} shrink-0 object-cover`}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="m-0 type-body font-semibold text-ink">{title}</p>
          <p className="m-0 type-caption text-ink-2">{hint}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {picker.element}
        <Button variant="secondary" size="sm" busy={picker.busy} onClick={picker.pick}>
          {photo === null ? `Add ${title.toLowerCase()}` : 'Change'}
        </Button>
        {photo === null ? null : (
          <Button
            variant="quiet"
            size="sm"
            busy={remover.busyId === photo.id}
            disabled={picker.busy}
            onClick={() => void remover.remove(photo.id)}
          >
            Remove
          </Button>
        )}
      </div>
      {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
    </div>
  );
}

function Gallery({
  slug,
  businessName,
  photos,
  onAdded,
  onRemoved,
}: {
  slug: string;
  businessName: string;
  photos: PublicPhoto[];
  onAdded: (photo: BusinessPhoto) => void;
  onRemoved: (kind: BusinessPhotoKind, id: string) => void;
}) {
  const [message, setMessage] = useState<Message>(null);
  const picker = usePicker('gallery', onAdded, setMessage);
  const remover = useRemove('gallery', onRemoved, setMessage);
  const full = photos.length >= MAX_GALLERY_PHOTOS;
  return (
    <div className="flex flex-col gap-3 py-4" data-testid="photo-gallery">
      <div className="flex flex-col gap-0.5">
        <p className="m-0 type-body font-semibold text-ink">
          Your work{' '}
          <span className="type-caption font-normal text-ink-2 tabular-nums">
            {photos.length} of {MAX_GALLERY_PHOTOS}
          </span>
        </p>
        <p className="m-0 type-caption text-ink-2">
          {photos.length === 0
            ? 'Add a few cuts, colors or sets you’re proud of. Clients see them before they pick a service.'
            : 'A caption says what each one shows, also to clients who use a screen reader.'}
        </p>
      </div>
      {photos.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {photos.map((photo) => (
            <GalleryRow
              key={photo.id}
              slug={slug}
              businessName={businessName}
              photo={photo}
              removing={remover.busyId === photo.id}
              onRemove={() => void remover.remove(photo.id)}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {picker.element}
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          busy={picker.busy}
          disabled={full}
          onClick={picker.pick}
        >
          {full ? 'Gallery full' : 'Add photos'}
        </Button>
      </div>
      {full ? (
        <p className="m-0 type-caption text-ink-2">
          The gallery holds 12 photos. Remove one to add another.
        </p>
      ) : null}
      {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
    </div>
  );
}

function GalleryRow({
  slug,
  businessName,
  photo,
  removing,
  onRemove,
}: {
  slug: string;
  businessName: string;
  photo: PublicPhoto;
  removing: boolean;
  onRemove: () => void;
}) {
  const [saved, setSaved] = useState(photo.caption ?? '');
  const [caption, setCaption] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function save(): Promise<void> {
    setBusy(true);
    const answer = await sendJson('PATCH', `/v1/tenant/photos/${encodeURIComponent(photo.id)}`, {
      caption,
    });
    setBusy(false);
    const parsed = answer.ok ? BusinessPhotoSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setError(answer.ok ? 'Something went wrong. Try again.' : answer.message);
      return;
    }
    setError(undefined);
    setSaved(parsed.data.caption ?? '');
    setCaption(parsed.data.caption ?? '');
  }

  return (
    <li className="flex items-start gap-3" data-testid="gallery-photo">
      <PhotoImage
        src={photoSrc(slug, photo, 160)}
        alt={photoAlt({ ...photo, caption: saved === '' ? null : saved }, 'gallery', businessName)}
        width={photo.width}
        height={photo.height}
        className="size-16 shrink-0 rounded-md object-cover"
      />
      <form
        className="flex min-w-0 flex-1 flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          label="Caption"
          name="caption"
          placeholder="Skin fade, low taper"
          maxLength={MAX_PHOTO_CAPTION_LENGTH}
          value={caption}
          error={error}
          onChange={(event) => {
            setCaption(event.target.value);
          }}
        />
        <div className="flex flex-wrap gap-2">
          {caption.trim() === saved ? null : (
            <Button type="submit" variant="secondary" size="sm" busy={busy}>
              Save caption
            </Button>
          )}
          <Button variant="quiet" size="sm" busy={removing} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </form>
    </li>
  );
}
