"use client"

import { getDriveConfig } from "@/src/features/files"
import OneDrivePage from "./onedrive-page"
import GoogleDrivePage from "./google-drive-page"
import PublicDrivePage from "./onedrive-page"
import { useEffect, useState } from "react"

export default function Page() {
  const [driveType, setDriveType] = useState<string | undefined>(undefined)

  useEffect(() => {
    // Read the drive config on the client side only
    const driveConfig = getDriveConfig()
    setDriveType(driveConfig?.type)
  }, [])

  switch (driveType) {
    case "google-drive":
      return <GoogleDrivePage />
    case "google-drive-public":
      // Plain browse page: remote listing + local cache, no picker round trips.
      return <PublicDrivePage />
    case "onedrive":
      return <OneDrivePage />
    default:
      return null
  }
}
