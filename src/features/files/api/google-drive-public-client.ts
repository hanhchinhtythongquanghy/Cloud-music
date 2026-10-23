import {
  AUDIO_FORMAT_MAPPING,
  AudioTrackFileItem,
  BaseDriveClient,
  BaseFileItem,
  FileItem,
  FolderItem,
} from "./base-drive-client"

/**
 * Google Drive client for a PUBLICLY SHARED folder ("Anyone with the link"),
 * authenticated with a plain Google API Key only - no OAuth, no sign-in, no
 * consent screen, no tokens.
 *
 * The API key and the folder id are stored in localStorage on this device.
 * Requirements on the Google side:
 *   - Google Drive API enabled in the Cloud project that owns the key
 *   - the folder (and files inside) shared as "Anyone with the link: Viewer"
 *   - if the key has HTTP referrer restrictions, they must allow this app's origin
 */

const DB_KEY_API_KEY = "googleDrivePublic.apiKey"
const DB_KEY_FOLDER_ID = "googleDrivePublic.folderId"

const DRIVE_API = "https://www.googleapis.com/drive/v3"
const FOLDER_MIME = "application/vnd.google-apps.folder"

export interface PublicDriveSettings {
  apiKey: string
  folderId: string
}

export function getPublicDriveSettings(): PublicDriveSettings | null {
  try {
    const apiKey = localStorage.getItem(DB_KEY_API_KEY)
    const folderId = localStorage.getItem(DB_KEY_FOLDER_ID)
    if (!apiKey || !folderId) return null
    return { apiKey, folderId }
  } catch {
    return null
  }
}

export function savePublicDriveSettings(settings: PublicDriveSettings): void {
  localStorage.setItem(DB_KEY_API_KEY, settings.apiKey.trim())
  localStorage.setItem(DB_KEY_FOLDER_ID, settings.folderId.trim())
}

export function clearPublicDriveSettings(): void {
  localStorage.removeItem(DB_KEY_API_KEY)
  localStorage.removeItem(DB_KEY_FOLDER_ID)
}

/**
 * Accepts a bare id or any of the usual share links:
 *   https://drive.google.com/drive/folders/<id>?usp=sharing
 *   https://drive.google.com/drive/u/0/folders/<id>
 *   https://drive.google.com/open?id=<id>
 */
export function parseDriveFolderId(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const fromPath = text.match(/\/folders\/([a-zA-Z0-9_-]{10,})/)
  if (fromPath) return fromPath[1]
  const fromQuery = text.match(/[?&]id=([a-zA-Z0-9_-]{10,})/)
  if (fromQuery) return fromQuery[1]
  if (/^[a-zA-Z0-9_-]{10,}$/.test(text)) return text
  return null
}

class DriveApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function friendlyError(status: number, reason: string | undefined, fallback: string) {
  if (status === 400 && reason === "keyInvalid")
    return "The API key is invalid."
  if (status === 403 && reason === "accessNotConfigured")
    return "Google Drive API is not enabled for this API key's project."
  if (status === 403 && (reason === "forbidden" || reason === "insufficientFilePermissions"))
    return "The folder is not publicly shared. Set it to “Anyone with the link – Viewer”."
  if (status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" || reason === "dailyLimitExceeded"))
    return "Google Drive API quota exceeded. Try again later."
  if (status === 403 && reason === "downloadQuotaExceeded")
    return "Google Drive download quota exceeded for this file. Try again later."
  if (status === 403 && reason === "API_KEY_HTTP_REFERRER_BLOCKED")
    return "This API key does not allow requests from this site (HTTP referrer restriction)."
  if (status === 404)
    return "Folder or file not found (check the ID and that it is shared publicly)."
  return fallback
}

export interface PublicDriveClient extends BaseDriveClient {
  readonly folderId: string
}

export async function createPublicDriveClient(): Promise<PublicDriveClient | null> {
  const settings = getPublicDriveSettings()
  if (!settings) return null
  const { apiKey, folderId } = settings

  const url = (path: string, params: Record<string, string>) => {
    const qs = new URLSearchParams({ ...params, key: apiKey })
    return `${DRIVE_API}${path}?${qs.toString()}`
  }

  async function request(input: string): Promise<Response> {
    const response = await fetch(input)
    if (response.ok) return response
    let reason: string | undefined
    let message = `${response.status} ${response.statusText}`.trim()
    try {
      const body = await response.json()
      reason = body?.error?.errors?.[0]?.reason ?? body?.error?.details?.[0]?.reason
      message = body?.error?.message || message
    } catch {}
    throw new DriveApiError(response.status, friendlyError(response.status, reason, message))
  }

  function toItem(item: any): BaseFileItem {
    const parentId: string | undefined = item.parents?.[0]
    if (item.mimeType === FOLDER_MIME) {
      return { name: item.name || "", id: item.id, type: "folder", parentId } as FolderItem
    }
    const ext = (item.name || "").split(".").pop()?.toLowerCase() || ""
    const format = AUDIO_FORMAT_MAPPING[ext]
    // Some tracks have no usable extension but a real audio mimeType.
    const mimeType: string | undefined =
      format?.mimeType ??
      (typeof item.mimeType === "string" && item.mimeType.startsWith("audio/")
        ? item.mimeType
        : undefined)
    if (mimeType) {
      return {
        name: item.name || "",
        id: item.id,
        type: "audio-track",
        parentId,
        mimeType,
      } as AudioTrackFileItem
    }
    return { name: item.name || "", id: item.id, type: "file", parentId } as FileItem
  }

  const FIELDS = "id,name,mimeType,parents"

  return {
    folderId,
    async resetUser() {
      clearPublicDriveSettings()
    },
    async connect() {
      // Verifies key + folder up front so problems surface at startup.
      await request(url(`/files/${folderId}`, { fields: FIELDS, supportsAllDrives: "true" }))
    },
    async getRootFolderId() {
      return folderId
    },
    async getFile(fileId: string) {
      const response = await request(
        url(`/files/${fileId}`, { fields: FIELDS, supportsAllDrives: "true" })
      )
      const item = toItem(await response.json())
      // The configured folder is the root of this library: it must not link
      // to a parent we cannot (and should not) browse into.
      if (item.id === folderId) item.parentId = undefined
      return item
    },
    async getChildren(parentId: string) {
      const out: BaseFileItem[] = []
      let pageToken: string | undefined
      do {
        const params: Record<string, string> = {
          q: `'${parentId}' in parents and trashed=false`,
          fields: `nextPageToken,files(${FIELDS})`,
          pageSize: "1000",
          orderBy: "folder,name",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        }
        if (pageToken) params.pageToken = pageToken
        const response = await request(url("/files", params))
        const data = await response.json()
        for (const f of data.files || []) {
          const item = toItem(f)
          // Re-parent explicitly: shortcuts/multi-parent files may report others.
          item.parentId = parentId
          out.push(item)
        }
        pageToken = data.nextPageToken
      } while (pageToken)
      return out
    },
    async fetchFileBlob(fileId: string) {
      const response = await request(
        url(`/files/${fileId}`, { alt: "media", supportsAllDrives: "true" })
      )
      return await response.blob()
    },
  }
}
