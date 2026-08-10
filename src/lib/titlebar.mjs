// The native desktop shell hosts the renderer in a framed window whose real
// window controls sit directly above the in-page titlebar, so the decorative
// traffic-light dots must only render in browser mode where no native window
// controls exist.
export function decorativeTrafficLightsVisible(desktopBridge) {
  return !desktopBridge
}
