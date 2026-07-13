/**
 * ToolTrace Application
 *
 * Client-side tool outline tracing application.
 * Workflow: Detect Paper → Trace Tools → Configure Layout → 3D Design → Export
 *
 * The whole app frame lives in <WorkflowShell/>, which mirrors the RapidTool-Fixture
 * shell (glass header, icon rail, Context Options + Properties panels, status bar).
 */

import { useEffect } from 'react';
import { WorkflowShell } from './components/WorkflowShell';
import { AuthGate } from './components/AuthGate';
import { ErrorBoundary } from './components';
import { warmupTracer } from './workers';

function App() {
  // Wake the backend tracer the moment the app loads (not at trace time) — if it's
  // asleep, the cold start happens in the background while the user is still
  // uploading/calibrating, instead of stalling their first trace click.
  useEffect(() => { warmupTracer(); }, []);

  return (
    <ErrorBoundary>
      <AuthGate>
        <WorkflowShell />
      </AuthGate>
    </ErrorBoundary>
  );
}

export default App;
