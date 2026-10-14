// A pilot's avatar: their https image from sign-in, or a chamfered square with their initial. A plain
// <img> (no image optimizer in between) that sends no referrer to the image's host.
export function PilotAvatar({ name, url, size }: { name: string; url: string | null; size: number }) {
  if (url) {
    return <img className="pilot-avatar" src={url} width={size} height={size} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" />;
  }
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span className="pilot-avatar pilot-avatar--none" style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} aria-hidden="true">
      {initial}
    </span>
  );
}
