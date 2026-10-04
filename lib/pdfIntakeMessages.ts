// Shown when a PDF needs a password just to open. We never prompt for one: the
// intake paths (Add Template, Quickfill) and the download path all refuse with this.
export const PASSWORD_PDF_MESSAGE =
  "This PDF is password-protected. Remove the password and try again.";

// Shown when an owner-password PDF's permissions allow neither filling forms nor
// annotating. Intake (openPdf) refuses it; the download path is the backstop for
// templates created before the gate.
export const FILL_FORBIDDEN_MESSAGE = "The author of this PDF doesn't allow it to be filled in.";
