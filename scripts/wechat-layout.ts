import type {CheerioAPI} from "cheerio";
import {isTag, type Element} from "domhandler";

// Translate only editorial signals; never copy third-party CSS into a note.
export function preserveWechatLayout($: CheerioAPI, root: Element) {
  const blocks = "p,section,div,figure,h1,h2,h3,h4,h5,h6";
  const css = new WeakMap<Element, Map<string,string>>();
  function property(el: Element, name: string): string {
    if (!css.has(el)) {
      const styles = new Map<string,string>();
      for (const part of (el.attribs.style || "").split(";")) {
        const i = part.indexOf(":");
        if (i > 0) styles.set(part.slice(0,i).trim().toLowerCase(),part.slice(i+1).trim().toLowerCase());
      }
      css.set(el,styles);
    }
    return css.get(el)!.get(name) || "";
  }
  function inherited(el: Element, name: string): string {
    for (let p: Element | null = el; p && p !== root; p = p.parent && isTag(p.parent) ? p.parent : null) {
      const v = property(p,name);
      if (v) return v;
      if (name === "font-weight" && /^(b|strong)$/.test(p.name)) return "bold";
    }
    return "";
  }
  const bold = (weight:string) => /^(bold(er)?|[6-9]00)$/.test(weight);
  // Some editors wrap a title card, including spacing blocks, in a native heading.
  // Put the heading on its text so Markdown renders it on one line.
  $(root).find("h1,h2,h3,h4,h5,h6").each((_, heading) => {
    const descendants = $(heading).find(blocks);
    if (!descendants.length) return;
    const text = $(heading).text().trim();
    const leaf = descendants.toArray().find(el =>
      !$(el).find(blocks).length && text && $(el).text().trim() === text);
    if (leaf) leaf.name = heading.name;
    heading.name = "div";
  });
  const inferred = new Set<Element>();
  let previousImage = false;
  for (const el of $(root).find(blocks + ",figcaption,img").toArray()) {
    const box = $(el);
    if (el.name === "img") { previousImage = true; continue; }
    if (box.find(blocks + ",figcaption").length || box.closest("pre,code,table,li").length) continue;
    const text = box.text().trim();
    if (!text) {
      if (/^h[1-6]$/.test(el.name)) el.name = "div";
      if (el.name === "p" && !box.find("img,hr,video").length) box.remove();
      continue;
    }
    const leaves = [el,...box.find("*").toArray()].filter(n => n.children.some(c => c.type === "text" && c.data.trim()));
    const small = leaves.length > 0 && leaves.every(n => /^(?:1[0-4]|[89])px$/.test(inherited(n,"font-size")));
    const muted = leaves.every(n => /^(?:gray|grey|#(?:888(?:888)?|999(?:999)?|666(?:666)?)|rgb\(\s*(?:136,\s*136,\s*136|153,\s*153,\s*153)\s*\))$/.test(inherited(n,"color")));
    const implicitCaption = small && muted && !box.find("a").length && !/^(作者|编辑|未经)/.test(text);
    const caption = box.closest("figcaption").length > 0 || (previousImage && (/^(?:图注\s*[：:]|图\s*\d+[：:.、\s])/.test(text) || implicitCaption));
    previousImage = false;
    if (caption) {
      el.name = "p";
      box.wrapInner("<em></em>");
      continue;
    }
    if (/^h[1-6]$/.test(el.name) || text.length > 55 || box.find("img").length || !leaves.length) continue;
    const centered = inherited(el,"text-align") === "center";
    const large = leaves.every(n => /^\d+(?:\.\d+)?px$/.test(inherited(n,"font-size")) && parseFloat(inherited(n,"font-size")) >= 18);
    const strong = leaves.every(n => bold(inherited(n,"font-weight")));
    const decorated = box.find("[style]").toArray().some(n => $(n).text().trim() === text &&
      property(n,"display") === "inline-block" && (property(n,"border-bottom") || property(n,"background-image")));
    if (large && (strong || centered)) el.name = "h2";
    else if (centered && decorated) el.name = "h3";
    if (/^h[23]$/.test(el.name)) inferred.add(el);
  }
  // A numbered title card can spread one heading over several styled paragraphs.
  for (const number of inferred) {
    if (!/^\d{1,2}$/.test($(number).text().trim())) continue;
    for (const parent of $(number).parentsUntil(root).toArray()) {
      const headings = $(parent).find("h2,h3").toArray();
      if (headings.length < 2) continue;
      if (headings[0] !== number || !headings.every(h => inferred.has(h))) break;
      const title = headings.map(h => $(h).text().trim()).join("");
      if ($(parent).text().replace(/\s/g,"") !== title.replace(/\s/g,"")) break;
      const sequence = $(parent).find("h2,h3,img").toArray();
      if (sequence.slice(sequence.indexOf(number)).some(n => n.name === "img")) break;
      $(number).find("br").remove();
      $(number).append(" ");
      for (const line of headings.slice(1)) {
        $(line).find("br").remove();
        $(number).append($(line).contents());
        $(line).remove();
      }
      break;
    }
  }
  // Resolve inherited weights per text run, including an explicit reset inside a bold span.
  function mark(el: Element, weight: string, inStyledHeading = false) {
    if (["pre","code","style","script"].includes(el.name)) return;
    const next = property(el,"font-weight") || (/^(strong|b)$/.test(el.name) ? "bold" : weight);
    if (/^(strong|b)$/.test(el.name)) el.name = "span";
    const alreadyBold = inStyledHeading || inferred.has(el);
    for (const child of [...el.children]) {
      if (isTag(child)) mark(child,next,alreadyBold);
      else if (child.type === "text" && child.data.trim() && bold(next) && !alreadyBold) $(child).wrap("<strong></strong>");
    }
    if (el.name === "span") $(el).replaceWith($(el).contents());
  }
  mark(root,"");
  $(root).find("strong").each((_,el) => {
    const next = el.nextSibling;
    if (next && isTag(next) && next.name === "strong") {
      $(next).prepend($(el).contents());
      $(el).remove();
    }
  });
}
