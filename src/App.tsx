/**
 * ToolTrace Application
 *
 * Client-side tool outline tracing application.
 * Workflow: Detect Paper → Trace Tools → Configure Layout → 3D Design → Export
 *
 * The whole app frame lives in <WorkflowShell/>, which mirrors the RapidTool-Fixture
 * shell (glass header, icon rail, Context Options + Properties panels, status bar).
 */

import { WorkflowShell } from './components/WorkflowShell';
import { AuthGate } from './components/AuthGate';
import { ErrorBoundary } from './components';

function App() {
  return (
    <ErrorBoundary>
      <AuthGate>
        <WorkflowShell />
      </AuthGate>
    </ErrorBoundary>
  );
}

export default App;
