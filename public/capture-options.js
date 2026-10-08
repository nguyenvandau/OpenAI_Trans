export function isCaptureMode(inputMode) {
  return inputMode === 'microphone' || inputMode === 'mixer';
}

export function noiseReductionForCapture(inputMode = 'microphone', setting = 'auto') {
  if (!isCaptureMode(inputMode)) throw new RangeError('Invalid audio input mode');
  const type = setting === 'auto' ? (inputMode === 'microphone' ? 'far_field' : 'none') : setting;
  return ['near_field', 'far_field'].includes(type) ? { type } : null;
}

export function captureAudioConstraints(deviceId, inputMode = 'microphone') {
  if (!isCaptureMode(inputMode)) throw new RangeError('Invalid audio input mode');
  const microphone = inputMode === 'microphone';
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: microphone,
    noiseSuppression: microphone,
    autoGainControl: false,
  };
}
