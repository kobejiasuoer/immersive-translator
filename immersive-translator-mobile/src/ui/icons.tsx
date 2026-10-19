/**
 * v3 图标（§1.7）：单色描边 SVG，viewBox 24 / stroke 1.6 / 圆头 /
 * currentColor / fill:none。与原型 prototypes/mobile-v3-2026-09-24.html
 * 的 I 表同源。禁 emoji 与裸字符当图标（治 V6）。
 */

const P: Record<string, string> = {
  today: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10.2h16M8.5 3.2v3.6M15.5 3.2v3.6"/><circle cx="12" cy="15.2" r="1.5" fill="currentColor" stroke="none"/>',
  wave: '<path d="M4 10v4M8 7v10M12 4.5v15M16 7v10M20 10v4"/>',
  shelf: '<path d="M5.5 4.5v15M10 4.5v15M14.6 4.9l3.7 14.2"/><path d="M4 19.5h16"/>',
  mark: '<path d="M7 4.5h10V19.5l-5-3.9-5 3.9Z"/>',
  me: '<circle cx="12" cy="8.4" r="3.4"/><path d="M5.4 19.6c1.2-3.3 3.7-5 6.6-5s5.4 1.7 6.6 5"/>',
  play: '<path d="M8.5 5.8v12.4l10-6.2Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8.2 5.5v13M15.8 5.5v13" stroke-width="2.4"/>',
  prev: '<path d="M17.5 5.8v12.4L9 12Z" fill="currentColor" stroke="none"/><path d="M6.8 5.5v13" stroke-width="2"/>',
  next: '<path d="M6.5 5.8v12.4L15 12Z" fill="currentColor" stroke="none"/><path d="M17.2 5.5v13" stroke-width="2"/>',
  mic: '<rect x="9.2" y="3.5" width="5.6" height="10.5" rx="2.8"/><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.8v2.9"/>',
  cam: '<path d="M4 8.2c0-1 .8-1.9 1.9-1.9h1.8l1.2-1.8h6.2l1.2 1.8h1.8c1 0 1.9.8 1.9 1.9v8.9c0 1-.8 1.9-1.9 1.9H5.9c-1 0-1.9-.8-1.9-1.9Z"/><circle cx="12" cy="12.4" r="3.4"/>',
  clip: '<rect x="7" y="4.5" width="10" height="15.5" rx="1.6"/><path d="M9.8 3.2h4.4v2.6H9.8Z"/><path d="M9.6 9.4h4.8M9.6 12.6h4.8M9.6 15.8h3"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.4v2.3M12 18.3v2.3M3.4 12h2.3M18.3 12h2.3M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6"/>',
  speaker: '<path d="M4.5 9.5v5h3l4.5 3.8V5.7L7.5 9.5Z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 7a7.4 7.4 0 0 1 0 10"/>',
  slow: '<path d="M4.5 9.5v5h3l4.5 3.8V5.7L7.5 9.5Z"/><path d="M16 10.5l4 1.5-4 1.5"/>',
  search: '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6 20 20"/>',
  share: '<path d="M12 14.5V4.2M8.4 7.4 12 3.8l3.6 3.6"/><path d="M6.5 11H5.4v9h13.2v-9h-1.1"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.8l4.4 4.4L19 7.5"/>',
  right: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  left: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  eye: '<path d="M2.8 12S6.2 5.9 12 5.9 21.2 12 21.2 12 17.8 18.1 12 18.1 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.9"/>',
  eyeoff: '<path d="M4 4l16 16"/><path d="M9.9 5.2A9.5 9.5 0 0 1 12 5c5.8 0 9.2 7 9.2 7a16 16 0 0 1-2.6 3.5M6.3 6.9A15 15 0 0 0 2.8 12s3.4 7 9.2 7a9 9 0 0 0 3.8-.8"/><path d="M9.9 9.9a2.9 2.9 0 0 0 4.2 4.2"/>',
  undo: '<path d="M8.5 6.5 4.5 10l4 3.5"/><path d="M4.5 10h9.2a5 5 0 0 1 0 10H9"/>',
  kbd: '<rect x="3" y="6.5" width="18" height="11.5" rx="2"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14.4h9"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
  note: '<path d="M6 3.8h9.5L19 7.3V20a.8.8 0 0 1-.8.8H6a.8.8 0 0 1-.8-.8V4.6c0-.5.3-.8.8-.8Z"/><path d="M15 3.8v4h4M9 12h6M9 15.5h4.5"/>',
  star: '<path d="m12 4.6 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.9l5-.7Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  aa: '<path d="M3.5 18.5 8.6 5.5l5.1 13M5.2 14.4h6.8"/><path d="m14.8 18.5 3.3-8.6 3.3 8.6M15.9 15.9h4.4"/>',
  dots: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  bolt: '<path d="M13 3.5 5.5 13.5H11l-1 7L18.5 10H13Z"/>',
  chat: '<path d="M12 4.5c4.6 0 8 2.8 8 6.4s-3.4 6.4-8 6.4c-.9 0-1.8-.1-2.6-.3L6.2 19l.5-2.9C5 15 4 13.1 4 10.9c0-3.6 3.4-6.4 8-6.4Z"/>',
  book: '<path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h12.5v15.5H7a2.5 2.5 0 0 0-2.5 2.5Z"/><path d="M4.5 5.5v15.5A2.5 2.5 0 0 1 7 18.5h12.5"/>',
  hist: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2.2"/>',
  flask: '<path d="M9.5 3.5h5M10.5 3.5v5.2L5.6 17a2 2 0 0 0 1.8 3h9.2a2 2 0 0 0 1.8-3l-4.9-8.3V3.5"/><path d="M8 14h8"/>',
  trash: '<path d="M5 6.5h14M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7M7 6.5l.8 12.2c.1.9.8 1.6 1.7 1.6h5c.9 0 1.6-.7 1.7-1.6L17 6.5"/><path d="M10.2 10v6M13.8 10v6"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="1.8"/><path d="M5.5 14.5h-.7a1.3 1.3 0 0 1-1.3-1.3V4.8a1.3 1.3 0 0 1 1.3-1.3h8.4a1.3 1.3 0 0 1 1.3 1.3v.7"/>',
  chevr: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  none: "",
};

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: P[name] || "" }}
    />
  );
}
