/**
 * Just enough XML to build these requests. NAV's schemas are strict about
 * order and namespaces, so the builder is explicit rather than clever: a tree
 * of names and values, written out in the order given.
 */

export type XmlNode = { name: string; children?: XmlNode[]; text?: string; attributes?: Record<string, string> };

export function element(
  name: string,
  children: XmlNode[] | string | undefined,
  attributes?: Record<string, string>,
): XmlNode {
  return typeof children === "string"
    ? { name, text: children, attributes }
    : { name, children: children ?? [], attributes };
}

/**
 * Characters XML 1.0 cannot carry at all, escaped or not: the C0 controls
 * other than tab, line feed and carriage return, lone surrogates, and the two
 * noncharacters at the end of the basic plane.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NOT_IN_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class InvalidXmlText extends Error {
  constructor(readonly text: string) {
    super(`text contains a character XML cannot carry: ${JSON.stringify(text.slice(0, 80))}`);
    this.name = "InvalidXmlText";
  }
}

/**
 * The five characters XML cannot carry raw, escaped. Text with a character
 * XML cannot carry at all is refused rather than quietly changed: what NAV
 * receives must be what the invoice says.
 */
export function escapeXml(text: string): string {
  if (NOT_IN_XML.test(text)) throw new InvalidXmlText(text);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function writeNode(node: XmlNode): string {
  const attributes = Object.entries(node.attributes ?? {})
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join("");

  if (node.text !== undefined) {
    return `<${node.name}${attributes}>${escapeXml(node.text)}</${node.name}>`;
  }
  const children = (node.children ?? []).map(writeNode).join("");
  return children === ""
    ? `<${node.name}${attributes}/>`
    : `<${node.name}${attributes}>${children}</${node.name}>`;
}

export function writeXml(root: XmlNode): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${writeNode(root)}`;
}

/** Drops the nodes whose value is undefined, so optional fields can be listed. */
export function optional(nodes: (XmlNode | undefined)[]): XmlNode[] {
  return nodes.filter((node): node is XmlNode => node !== undefined);
}
