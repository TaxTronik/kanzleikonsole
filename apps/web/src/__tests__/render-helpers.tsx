// Hilfen für Render-Tests von Server Components (B-08, Welle 15).
//
// Next rendert async Server Components serverseitig; react-dom kann sie weder
// in renderToStaticMarkup noch im Client-Render auflösen. resolveServerTree
// ruft deshalb jede async Funktionskomponente des Baums mit ihren Props auf und
// setzt ihr Ergebnis ein. Client Components bleiben unverändert und laufen
// anschließend normal (statisch oder in jsdom mit Effekten und Interaktion).
// Synchrone Server Components (z. B. ein Layout, das nur <AuthShell> rendert)
// ruft der Test selbst auf: `renderServer(Layout({ children }))`.
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render } from '@testing-library/react';

type AnyProps = Record<string, unknown> & { children?: ReactNode };

function isAsyncComponent(type: unknown): type is (props: AnyProps) => Promise<ReactNode> {
  return typeof type === 'function' && type.constructor.name === 'AsyncFunction';
}

/** Löst alle async Server Components eines Elementbaums auf. */
export async function resolveServerTree(node: ReactNode | Promise<ReactNode>): Promise<ReactNode> {
  const value = await node;
  if (Array.isArray(value)) return Promise.all(value.map((child) => resolveServerTree(child)));
  if (!isValidElement(value)) return value;
  const element = value as ReactElement<AnyProps>;
  if (isAsyncComponent(element.type)) {
    return resolveServerTree(element.type(element.props));
  }
  const children = element.props.children;
  if (children === undefined || children === null) return element;
  const resolved = await resolveServerTree(
    Array.isArray(children) ? Children.toArray(children) : children,
  );
  return cloneElement(element, undefined, resolved);
}

/** Server Component (oder deren Promise) als statisches HTML. */
export async function renderServerMarkup(node: ReactNode | Promise<ReactNode>): Promise<string> {
  return renderToStaticMarkup(<>{await resolveServerTree(node)}</>);
}

/** Server Component in jsdom rendern (Client Components laufen mit Effekten). */
export async function renderServer(node: ReactNode | Promise<ReactNode>) {
  return render(<>{await resolveServerTree(node)}</>);
}
