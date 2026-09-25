// File types Cipher can read. No Node imports here, so the interface can use this too.

export const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.xlsx', '.epub', '.txt', '.md', '.csv', '.html', '.htm']
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
export const SUPPORTED_EXTENSIONS = [...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS]
// The most files Cipher takes from one folder (subfolders included)
export const MAX_FOLDER_FILES = 500

export function isSupported(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 && SUPPORTED_EXTENSIONS.includes(fileName.slice(dot).toLowerCase())
}
