// Decrypts an owner-password-only PDF (e.g. every USCIS form: AES-128, opens with
// an empty user password) so plain pdf-lib can load it. Only stampPdf calls this,
// and only via a dynamic import() once the source is known to be encrypted, so the
// @cantoo/pdf-lib fork never loads for an ordinary download. Pure: no fetch, no
// data source — bytes in, unencrypted bytes out, all in the browser.
import type * as PdfLib from "pdf-lib";

import { FILL_FORBIDDEN_MESSAGE, PASSWORD_PDF_MESSAGE } from "@/lib/pdfIntakeMessages";

// /P bits (ISO 32000-1 Table 22): 6 = annotate/fill, 9 = fill forms (revision >= 3).
const P_MODIFY_ANNOTATIONS = 0x20;
const P_FILL_INTERACTIVE_FORMS = 0x100;

// The download backstop for the intake gate in openPdf: refuse a PDF whose author
// allows neither filling forms nor annotating (templates created before the gate).
// `doc` is the still-encrypted ignoreEncryption load; /P is a plain integer in the
// trailer's /Encrypt dict, so it reads without decrypting anything.
export function assertFillPermitted(doc: PdfLib.PDFDocument, pdfLib: typeof PdfLib): void {
  const encrypt = doc.context.lookup(doc.context.trailerInfo.Encrypt);
  if (!(encrypt instanceof pdfLib.PDFDict)) return;
  const p = encrypt.lookup(pdfLib.PDFName.of("P"));
  if (!(p instanceof pdfLib.PDFNumber)) return;
  if ((p.asNumber() & (P_FILL_INTERACTIVE_FORMS | P_MODIFY_ANNOTATIONS)) === 0) {
    throw new Error(FILL_FORBIDDEN_MESSAGE);
  }
}

export async function decryptPdf(pdfBytes: ArrayBuffer): Promise<Uint8Array> {
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes, { password: "" });
  } catch (e) {
    // A real user password (not the empty one) is required to open it.
    if (e instanceof Error && e.message === "NEEDS PASSWORD") {
      throw new Error(PASSWORD_PDF_MESSAGE);
    }
    throw e;
  }
  // The fork drops the security handler on load, so save() writes no /Encrypt.
  // The source's permission flags go with it (see the encrypted-source handoff).
  return doc.save();
}
