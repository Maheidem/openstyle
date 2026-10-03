const processing = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/**
 * Open the microphone with the configured device and no audio processing.
 * A stale device id must not fail the capture, so on a missing device the
 * function retries with the default microphone.
 */
export async function openMicStream(
  deviceId?: string | null,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { deviceId: { exact: deviceId }, ...processing }
        : processing,
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (
      deviceId &&
      (name === "OverconstrainedError" || name === "NotFoundError")
    ) {
      return navigator.mediaDevices.getUserMedia({ audio: processing });
    }
    throw e;
  }
}
