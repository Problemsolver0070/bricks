export const PLATFORM_KNOWLEDGE = `
## About Bricks

Bricks is a web-based platform that lets users build web applications using AI. It has two modes:

### Chat Mode
- Full conversational AI experience
- Ask anything — coding, brainstorming, analysis, writing
- Conversation history is saved and accessible in the sidebar

### Build Mode
- Describe what you want to build
- The Fixer writes the complete code
- Live preview shows the running application
- Edit code manually or ask The Fixer to make changes
- Supports React, TypeScript, Tailwind CSS, and more

### Accounts & Billing
- New users get a 48-hour free trial with unlimited access
- Pro plan is $20/month via PayPal
- No credit card required for the free trial

### The Fixer AI
- The Fixer is the proprietary AI assistant powering Bricks
- It can help with any programming language or framework
- In Build mode, it generates complete, runnable projects
- It can modify existing code based on natural language instructions

### Supported Technologies (Build Mode)
- React + TypeScript + Vite (default)
- Tailwind CSS for styling
- Any npm package can be used
- The preview runs entirely in your browser

### Tips
- Be specific about what you want to build
- You can iterate: ask The Fixer to modify specific parts
- In Build mode, switch between Code and Preview tabs
- You can edit code directly in the editor
`;

export function getKnowledgeContext(query: string): string | undefined {
  const lowerQuery = query.toLowerCase();
  const keywords = [
    "bricks",
    "platform",
    "how do",
    "what is",
    "help",
    "pricing",
    "plan",
    "trial",
    "build mode",
    "chat mode",
    "the fixer",
    "subscribe",
    "billing",
  ];

  if (keywords.some((kw) => lowerQuery.includes(kw))) {
    return PLATFORM_KNOWLEDGE;
  }

  return undefined;
}
