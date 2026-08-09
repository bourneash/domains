import { useEffect } from "react";

/** Set document title + description per route. SPA routing means neither
 *  updates on its own, and both matter for how pages get shared and indexed. */
export function usePageMeta(title: string, description: string, canonicalPath?: string) {
  useEffect(() => {
    document.title = title;
    const set = (selector: string, attr: string, value: string) => {
      let el = document.head.querySelector(selector) as HTMLElement | null;
      if (!el) {
        el = document.createElement(selector.startsWith("link") ? "link" : "meta");
        if (selector.includes("canonical")) el.setAttribute("rel", "canonical");
        else el.setAttribute("name", selector.replace(/meta\[name="|"\]/g, ""));
        document.head.appendChild(el);
      }
      el.setAttribute(attr, value);
    };
    set('meta[name="description"]', "content", description);
    if (canonicalPath) {
      set('link[rel="canonical"]', "href", `https://trainingsharks.com${canonicalPath}`);
    }
  }, [title, description, canonicalPath]);
}
