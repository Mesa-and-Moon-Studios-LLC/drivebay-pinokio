export function normalizePath(pathname: string | null | undefined): string;

export function wantsJsonError(
  pathname: string | null | undefined,
  accept: string | null | undefined,
): boolean;

export function isStaticAssetPath(pathname: string | null | undefined): boolean;

export function isSpaDocument(
  pathname: string | null | undefined,
  accept: string | null | undefined,
  method: string | null | undefined,
): boolean;

export function homeLocation(
  pathname: string | null | undefined,
  hostname: string | null | undefined,
  hasSession: boolean,
): "/settings" | "/login" | null;

export function documentErrorAction(
  pathname: string | null | undefined,
  status: number,
  contentType: string | null | undefined,
  bodyText?: string | null,
): "html" | "redirect" | null;

export function locationFor(requestUrl: string, pathname: string): string;

export function redirectResponse(requestUrl: string, pathname: string): Response;

export function signInPageHtml(): string;

export function signInHtmlResponse(): Response;

export function replacementForDocumentError(
  requestUrl: string,
  pathname: string | null | undefined,
  status: number,
  contentType: string | null | undefined,
  bodyText?: string | null,
): Response | null;
