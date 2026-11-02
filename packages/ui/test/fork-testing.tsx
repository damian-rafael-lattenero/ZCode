/*
 * (FORK) Mini reemplazo de @testing-library/react — upstream v3.17.1 retiró la
 * dependencia (y de @testing-library/dom) de packages/ui; estos 5 tests de UI del
 * fork solo necesitan render / screen / fireEvent.click / waitFor / renderHook.
 * Implementado con createRoot + act sobre jsdom para mantener packages/ui/package.json
 * y pnpm-lock.yaml 100% idénticos a upstream (decisión A1 de la expedición v3.17.1).
 *
 * Fidelidad razonable, no exhaustiva: getNodeText usa solo nodos de texto directos
 * (como RTL), getByRole resuelve roles implícitos + aria-role y nombre accesible por
 * textContent — suficiente para las consultas de esta suite.
 */
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// React exige este flag global para permitir act() fuera de react-dom/test-utils.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

export { act };

type MountedRoot = { root: Root; container: HTMLElement };
const mountedRoots: MountedRoot[] = [];

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** RTL igual: solo los nodos de TEXTO directos del elemento (los descendientes no cuentan). */
function getNodeText(element: Element): string {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  }
  return normalize(text);
}

type TextMatcher = string | RegExp;

function matchesText(text: string, matcher: TextMatcher): boolean {
  return typeof matcher === "string" ? text === matcher : matcher.test(text);
}

function queryAllByText(matcher: TextMatcher): Element[] {
  return Array.from(document.body.querySelectorAll("*")).filter((element) =>
    matchesText(getNodeText(element), matcher),
  );
}

const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: "button",
  A: "link",
  TEXTAREA: "textbox",
  SELECT: "combobox",
  OPTION: "option",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
};

function elementRole(element: Element): string | null {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName;
  if (tag === "INPUT") {
    const type = element.getAttribute("type") ?? "text";
    if (type === "submit" || type === "button") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }
  return IMPLICIT_ROLES[tag] ?? null;
}

/** RTL igual: aria-label primero; los subárboles aria-hidden no están en el a11y tree. */
function accessibleName(element: Element): string {
  return normalize(element.getAttribute("aria-label") ?? element.textContent ?? "");
}

function inAriaHiddenSubtree(element: Element): boolean {
  return element.closest('[aria-hidden="true"]') !== null;
}

function formatNotFound(kind: string, description: string): Error {
  return new Error(`[fork-testing] unable to find ${kind}: ${description}`);
}

function assertSingle(candidates: Element[], kind: string, description: string): Element {
  if (candidates.length === 0) throw formatNotFound(kind, description);
  if (candidates.length > 1) {
    throw new Error(
      `[fork-testing] found multiple elements (${candidates.length}) for ${kind}: ${description}`,
    );
  }
  return candidates[0]!;
}

export const screen = {
  getByText(matcher: TextMatcher): Element {
    const description = typeof matcher === "string" ? matcher : String(matcher);
    return assertSingle(queryAllByText(matcher), "element with text", description);
  },
  queryByText(matcher: TextMatcher): Element | null {
    return queryAllByText(matcher)[0] ?? null;
  },
  async findByText(matcher: TextMatcher): Promise<Element> {
    return waitFor(() => screen.getByText(matcher), { timeout: 1000 });
  },
  getByRole(role: string, options?: { name?: TextMatcher }): Element {
    const candidates = Array.from(document.body.querySelectorAll("*")).filter((element) => {
      if (elementRole(element) !== role) return false;
      if (inAriaHiddenSubtree(element)) return false;
      if (options?.name === undefined) return true;
      return matchesText(accessibleName(element), options.name);
    });
    return assertSingle(candidates, `element with role "${role}"`, String(options?.name ?? ""));
  },
  getByTestId(testId: string): Element {
    // jsdom no implementa CSS.escape; filtrar por valor evita dependencias del selector.
    const candidates = Array.from(document.body.querySelectorAll("[data-testid]")).filter(
      (element) => element.getAttribute("data-testid") === testId,
    );
    return assertSingle(candidates, "element with test id", testId);
  },
};

export function render(ui: ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  mountedRoots.push({ root, container });
  return {
    container,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

export function cleanup(): void {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
}

export const fireEvent = {
  click(element: Element): void {
    act(() => {
      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
      );
    });
  },
};

type WaitForOptions = { timeout?: number; interval?: number };

export async function waitFor<T>(
  callback: () => T,
  options: WaitForOptions = {},
): Promise<T> {
  const timeout = options.timeout ?? 1000;
  const interval = options.interval ?? 50;
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await act(async () => callback());
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, interval));
      });
    }
  }
}

type RenderHookOptions<TProps> = { initialProps?: TProps };

export function renderHook<TProps, TResult>(
  callback: (props: TProps) => TResult,
  options: RenderHookOptions<TProps> = {},
): {
  result: { current: TResult | undefined };
  rerender: (props?: TProps) => void;
  unmount: () => void;
} {
  const result: { current: TResult | undefined } = { current: undefined };
  let lastProps: TProps | undefined = options.initialProps;
  const Harness = ({ props }: { props: TProps }): ReactNode => {
    result.current = callback(props);
    return null;
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const mountWith = (props: TProps | undefined) => {
    act(() => {
      root.render(createElement(Harness, { props }));
    });
  };
  mountWith(lastProps as TProps);
  mountedRoots.push({ root, container });
  return {
    result,
    rerender: (props?: TProps) => {
      lastProps = props ?? lastProps;
      mountWith(lastProps as TProps);
    },
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}
