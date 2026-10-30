/** User-readable import failure shared by independent document parsers. */
export class FileImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileImportError";
  }
}
