# Mobile design and interaction acceptance

Aside uses the existing cream and forest-green identity. The interface follows the platform's familiar navigation, typography and control hierarchy; decorative branding must not compete with the audio or transcript.

## References

- [Apple HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout): importance, alignment, grouping, progressive disclosure, safe areas and adaptable layouts.
- [Apple HIG: Typography](https://developer.apple.com/design/human-interface-guidelines/typography): system fonts, legible sizes and a hierarchy that survives text scaling.
- [Apple HIG: Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons): recognizable actions and clear emphasis.
- [Apple HIG: Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars): stable destinations with recognizable labels.

## Decisions

- Library, Upload and Account remain stable destinations. Android Back first returns from a destination or episode before exiting.
- Episode title and content replace the marketing header in the player. The playback control is centered; skip and speed have less visual weight.
- Use system text for UI/content and the existing serif identity only for the small wordmark. No downloaded Apple fonts on Android.
- Transcript and completed conversations share the reading area. A subtle active passage keeps the text readable.
- One fixed question area provides text and deliberate hold-to-record entry. Empty/pending text submission is disabled. Recording shows preparation, elapsed time and cancel guidance. Leaving the actual button bounds cancels capture.
- Resume actions appear only during a question interruption. Leaving the player retains a mini player and the native audio session.
- Upload shows filename, numeric progress, a progress bar and cancellation. Retry reuses the selected local copy.
- Light/dark palettes use semantic surface, text, muted, accent and separator colors. Focus, selected and pressed states have visible feedback.

## Required visual and interaction review

On both installed Release apps, review Library, empty library, player transcript, conversation, recording, errors, upload, login and account. Inspect both languages, light/dark appearance and large text. Verify safe areas, readable contrast, untruncated primary actions, keyboard avoidance, touch target separation and scroll reachability. A successful compile or automation assertion alone does not satisfy visual acceptance.

Record actual simulator screenshots and flow reports. Keep unverified device/signing scenarios explicit in the release report.

Manual scrolling temporarily suspends transcript auto-follow. A labeled action returns to the current passage; advancing playback must never repeatedly pull a reader away from the section they chose.

At accessibility text sizes, content remains scalable and scrollable. The brand, navigation labels and transport labels have bounded scaling so the controls retain space for reading; the upload page scrolls to keep file selection and cancellation reachable on an iPhone SE.
