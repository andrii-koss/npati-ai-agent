import { useLayoutEffect, useRef, useState } from "react";

/** Keep a neutral, fixed-size surface until the avatar can be painted. */
export function ChatAvatarImage({ url, initials }: { url: string | null; initials: string }) {
  const image = useRef<HTMLImageElement>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const loaded = (element: HTMLImageElement, source: string) => {
    const ready = () => { if (image.current === element && element.getAttribute("src") === source) setReadyUrl(source); };
    if (element.decode) void element.decode().then(ready).catch(() => {
      if (image.current === element && element.getAttribute("src") === source && element.naturalWidth > 0) ready();
    });
    else ready();
  };
  useLayoutEffect(() => {
    const element = image.current;
    if (url && element?.complete && element.naturalWidth > 0) loaded(element, url);
  }, [url]);
  if (!url || failedUrl === url) return <>{initials}</>;
  return <span className="chat-user-avatar-image" data-avatar-state={readyUrl === url ? "ready" : "loading"}>
    <img ref={image} src={url} alt="" decoding="async" loading="eager" fetchPriority="high"
      onLoad={event => loaded(event.currentTarget, url)} onError={() => setFailedUrl(url)}
      style={{ opacity: readyUrl === url ? 1 : 0 }} />
  </span>;
}
