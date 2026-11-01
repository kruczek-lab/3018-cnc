const ERRORS: Record<number, string> = {
  1: 'G-code words consist of a letter and a value. Letter was not found.',
  2: 'Missing or invalid numeric value.',
  3: "'$' system command not recognized or supported.",
  4: 'Negative value received for an expected positive value.',
  5: 'Homing is not enabled in settings ($22). Your machine has no limit switches installed.',
  6: 'Minimum step pulse time must be greater than 3 µs.',
  7: 'EEPROM read failed. Settings were reset to defaults.',
  8: "'$' command can only be used when GRBL is idle.",
  9: 'G-code is locked out during alarm or jog state. Unlock with $X.',
  10: 'Soft limits cannot be enabled without homing.',
  11: 'Line too long; it was not executed.',
  12: 'Setting value exceeds the maximum step rate.',
  13: 'Safety door opened.',
  14: 'Build info or startup line too long.',
  15: 'Jog target exceeds machine travel. Command ignored.',
  16: "Jog command has no '=' or contains prohibited G-code.",
  17: 'Laser mode requires PWM output.',
  20: 'Unsupported or invalid G-code command.',
  21: 'More than one G-code command from the same modal group in a line.',
  22: 'Feed rate has not been set.',
  23: 'G-code command requires an integer value.',
  24: 'Two G-code commands in one line both need XYZ words.',
  25: 'A G-code word was repeated in the line.',
  26: 'G-code command requires XYZ words but none were given.',
  27: 'Line number out of range.',
  28: 'G-code command is missing a required P or L value.',
  29: 'Unsupported work coordinate system.',
  30: 'G53 requires G0 or G1 motion mode.',
  31: 'Axis words given while G80 motion cancel is active.',
  32: 'Arc has no XYZ words in the selected plane.',
  33: 'Invalid motion target (impossible arc or probe target).',
  34: 'Arc radius definition error.',
  35: 'Arc offset definition is missing its IJK words.',
  36: 'Unused G-code words left over in the line.',
  37: 'Tool length offset applied to the wrong axis.',
  38: 'Tool number greater than supported.',
};

const ALARMS: Record<number, string> = {
  1: 'Hard limit triggered. Position is likely lost.',
  2: 'Soft limit: target exceeds machine travel.',
  3: 'Reset while moving. Position is likely lost — re-check your zero.',
  4: 'Probe fail: probe was not in the expected state before starting.',
  5: 'Probe fail: probe did not make contact.',
  6: 'Homing fail: reset during homing.',
  7: 'Homing fail: safety door opened during homing.',
  8: 'Homing fail: could not clear the limit switch.',
  9: 'Homing fail: could not find the limit switch.',
};

export function describeError(code: number): string {
  return ERRORS[code] ?? 'Unknown error.';
}

export function describeAlarm(code: number): string {
  return ALARMS[code] ?? 'Unknown alarm.';
}
