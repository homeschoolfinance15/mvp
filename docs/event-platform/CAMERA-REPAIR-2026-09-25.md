# Camera QR repair

Reported on iPhone 14 Pro: Chrome showed “This browser cannot read QR codes.”
The application required native BarcodeDetector support and had no software
decoder. The video element also mounted only after camera startup, so its
stream could not be attached during startup.

The repair loads jsQR when the camera is requested and decodes video frames
locally. It no longer requires BarcodeDetector. The video element is mounted
before attaching the stream, muted, and uses inline playback. Pending camera
requests are invalidated on unmount and acquired tracks are stopped on failure.
Permission failures retain retry and manual entry. Ticket validation remains
server-side with the existing duplicate-arrival protections.

Validation: build passed; 50/50 local browser/API acceptance checks passed.
The camera test disabled BarcodeDetector, first denied permission, then provided
a real MediaStream from a canvas containing an actual ticket QR. The decoder
read that QR, called the real local check-in API, displayed Already checked in,
and retained one arrival. This verifies decoding and stream attachment rather
than mocking a decoded ticket string. Physical iPhone camera/lighting testing
still requires the user's device after release.

The QR dependency is a separate lazy-loaded asset (about 47.5 kB gzip).
Scoped lint had no errors and one existing React effect warning. The existing
main-bundle size warning remains.
