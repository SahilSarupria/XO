import { SourceFrontendRegistry } from './registry.js';
import { PdfSourceFrontend } from './pdf-frontend.js';
import { DocumentSourceFrontend } from './document-frontend.js';
import { HtmlSourceFrontend } from './html-frontend.js';
import { StructuredSourceFrontend } from './structured-frontend.js';
import { OpenApiSourceFrontend } from './openapi-frontend.js';
import { ImageSourceFrontend } from './image-frontend.js';

/** Builds a fresh `SourceFrontendRegistry` with every frontend this package ships registered. Registration order here (pdf, document, html, structured, openapi, image) is also `detect`'s probing order — each frontend's `canHandle` is specific enough (a `kind` discriminant, or a magic-byte sniff for untagged PDF/image bytes) that order does not change which frontend wins for any input this package's own tests construct, but it is still documented here because `SourceFrontendRegistry.detect` (`registry.ts`) is order-dependent by design. */
export function createDefaultSourceFrontendRegistry(): SourceFrontendRegistry {
  const registry = new SourceFrontendRegistry();
  registry.register(new PdfSourceFrontend());
  registry.register(new DocumentSourceFrontend());
  registry.register(new HtmlSourceFrontend());
  registry.register(new StructuredSourceFrontend());
  registry.register(new OpenApiSourceFrontend());
  registry.register(new ImageSourceFrontend());
  return registry;
}
