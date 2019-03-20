// @flow

import {PassThrough} from 'stream';
import {Reporter} from '@parcel/plugin';
import React from 'react';
import {render} from 'ink';
import UI from './UI';

// Ink expects stdout (or whatever is passed as stdout) to have a columns properly.
// In environments like Lerna child processes, this property does not exist.
// Create our own proxy object with `columns` on it that falls back to something sensible.
const stdoutProxy = new PassThrough();
stdoutProxy.pipe(process.stdout);
// $FlowFixMe Doing this intentionally to support the stdout api ink expects
stdoutProxy.columns =
  process.stdout.columns == null ? 80 : process.stdout.columns;

let ui: UI;
// $FlowFixMe
render(<UI ref={u => (ui = u)} />, {
  stdout: stdoutProxy
});

export default new Reporter({
  report(event, options) {
    ui.report(event, options);
  }
});
