/**
 * Demo Data for ChatGPT App Widgets
 *
 * Usage: Add ?demo=true to any widget URL to see demo data
 * Or import and use demoMode.isEnabled() to check demo state
 */

// Check if demo mode is enabled via URL param
export const demoMode = {
  isEnabled() {
    return new URLSearchParams(window.location.search).get('demo') === 'true';
  },

  toggle() {
    const url = new URL(window.location.href);
    if (this.isEnabled()) {
      url.searchParams.delete('demo');
    } else {
      url.searchParams.set('demo', 'true');
    }
    window.location.href = url.toString();
  },
};

// Demo data for decisions widget
export const demoDecisions = {
  decisions: [
    {
      id: 'dec-001',
      agent_name: 'Pace',
      type: 'approval',
      summary:
        'Approve the updated API authentication flow that uses JWT tokens with 15-minute expiry instead of session cookies.',
      urgency: 'critical',
      created_at: new Date(Date.now() - 1000 * 60 * 15).toISOString(), // 15 min ago
    },
    {
      id: 'dec-002',
      agent_name: 'Scout',
      type: 'decision',
      summary:
        'Select the recommended database indexing strategy for the user search feature. Options: B-tree vs Hash index.',
      urgency: 'high',
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours ago
    },
    {
      id: 'dec-003',
      agent_name: 'Compass',
      type: 'approval',
      summary:
        'Approve the new onboarding email sequence (5 emails over 14 days) drafted by the marketing team.',
      urgency: 'medium',
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), // 1 day ago
    },
    {
      id: 'dec-004',
      agent_name: 'Pace',
      type: 'decision',
      summary:
        'Choose between Stripe and Paddle for the new subscription billing system integration.',
      urgency: 'low',
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(), // 3 days ago
    },
  ],
  summary: {
    critical: 1,
    high: 1,
    medium: 1,
    low: 1,
  },
};

// Demo data for agent status widget
export const demoAgentStatus = {
  agents: [
    {
      agent_name: 'Pace',
      status: 'running',
      current_task: 'Drafting API specification for v2 endpoints',
      progress: 65,
    },
    {
      agent_name: 'Scout',
      status: 'running',
      current_task: 'Analyzing competitor pricing strategies',
      progress: 32,
    },
    {
      agent_name: 'Compass',
      status: 'blocked',
      current_task: 'Waiting for design review approval',
      blockers: ['Needs approval from Design Lead', 'Missing brand assets'],
    },
    {
      agent_name: 'Beacon',
      status: 'queued',
      current_task: 'Generate weekly performance report',
    },
    {
      agent_name: 'Atlas',
      status: 'idle',
      current_task: null,
    },
  ],
  summary: {
    running: 2,
    blocked: 1,
    queued: 1,
    idle: 1,
  },
};

// Demo data for search results widget
export const demoSearchResults = {
  query: 'authentication flow',
  results: [
    {
      id: 'art-001',
      type: 'artifact',
      title: 'JWT Authentication Implementation Guide',
      summary:
        'Complete guide for implementing JWT-based authentication including token refresh, revocation, and security best practices.',
      relevance_score: 0.95,
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    },
    {
      id: 'dec-101',
      type: 'decision',
      title: 'Approved: OAuth 2.0 Provider Selection',
      summary:
        'Decision to use Auth0 as the OAuth provider for enterprise SSO integration, approved by security team.',
      relevance_score: 0.87,
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    },
    {
      id: 'init-001',
      type: 'initiative',
      title: 'Q4 Security Hardening Initiative',
      summary:
        'Multi-phase initiative to improve authentication security including MFA rollout and session management improvements.',
      relevance_score: 0.72,
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(),
    },
    {
      id: 'art-002',
      type: 'artifact',
      title: 'User Session Flow Diagram',
      summary:
        'Technical diagram showing the complete user session lifecycle from login to logout including edge cases.',
      relevance_score: 0.68,
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    },
  ],
  displayMode: 'list', // or 'carousel'
};

// Demo data for initiative pulse widget
export const demoInitiativePulse = {
  name: 'Q4 Product Launch',
  status: 'Active',
  health_score: 78,
  progress_pct: 64,
  pending_decisions: 3,
  workstream_summary: {
    active: 4,
    completed: 2,
    blocked: 1,
  },
  milestones: [
    { name: 'API Development', status: 'Completed', progress: 100 },
    { name: 'Frontend Integration', status: 'Active', progress: 75 },
    { name: 'QA Testing', status: 'Active', progress: 40 },
    { name: 'Documentation', status: 'Blocked', progress: 20 },
  ],
  blockers: [
    'Waiting for final design assets from marketing',
    'Need security audit completion before launch',
  ],
};

// Demo data for task spawned widget
export const demoTaskSpawned = {
  message: 'Pace is now working on your request.',
  agent_name: 'Pace',
  task_summary:
    'Draft a technical specification for the new user authentication API endpoints',
  run_id: 'run_abc123def456',
  status: 'Running',
};

// Get demo data for a specific widget type
export function getDemoData(widgetType) {
  const data = {
    decisions: demoDecisions,
    'agent-status': demoAgentStatus,
    'search-results': demoSearchResults,
    'initiative-pulse': demoInitiativePulse,
    'task-spawned': demoTaskSpawned,
  };
  return data[widgetType] || null;
}

/**
 * Creates a demo mode toggle button
 * @returns {string} HTML string for the toggle button
 */
export function createDemoToggle() {
  const isDemo = demoMode.isEnabled();
  return `
    <button 
      onclick="window.toggleDemo()"
      style="
        position: fixed;
        top: 8px;
        right: 8px;
        padding: 6px 12px;
        font-size: 0.75rem;
        font-weight: 500;
        border-radius: 9999px;
        border: 1px solid ${
          isDemo ? '#10a37f' : 'var(--app-color-border, #e5e5e5)'
        };
        background: ${isDemo ? '#d1fae5' : 'var(--app-color-surface, #fff)'};
        color: ${
          isDemo ? '#065f46' : 'var(--app-color-text-secondary, #6e6e80)'
        };
        cursor: pointer;
        z-index: 9999;
        font-family: inherit;
        transition: all 0.15s ease;
      "
      onmouseover="this.style.opacity='0.8'"
      onmouseout="this.style.opacity='1'"
    >
      ${isDemo ? '✓ Demo Mode' : 'Demo Mode'}
    </button>
  `;
}

// Make toggle function available globally
if (typeof window !== 'undefined') {
  window.toggleDemo = () => demoMode.toggle();
}
