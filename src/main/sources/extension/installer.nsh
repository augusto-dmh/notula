; The browser extension's native-messaging keys.
; Included by electron-builder's NSIS script (electron-builder.cjs `nsis.include`).
; Uninstall deletes exactly the two HKCU keys Notula writes when the extension is turned on; an
; update (the old version's uninstaller runs too) leaves them, and the new version checks them at
; start. Never HKLM, never a parent key.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\app.notula.bridge"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\app.notula.bridge"
  ${endIf}
!macroend
