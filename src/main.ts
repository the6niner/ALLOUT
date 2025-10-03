import { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen as electronScreen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ExecException } from 'child_process';

const nut = require('@nut-tree-fork/nut-js');
const { keyboard: nutKeyboard, Key, screen: nutScreen, mouse: nutMouse } = nut;

const execAsync = (command: string, options?: any): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    exec(command, { ...options, shell: '/bin/bash' }, (error: ExecException | null, stdout: string, stderr: string) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

let mainWindow: BrowserWindow | null = null;
let screenWidth: number;
let centerX: number;
let primaryDisplay: any;
let copiedContent = '';
let speechContent = '';

// ++ Configuration Refactor ++
interface AppConfig {
  apiKey: string;
  model: string;
  theme: string;
  expandedHeight: number;
  dotOpacity: number;
  primaryColor: string;
  textColor: string;
  bgColor: string;
  borderColor: string;
  buttonBg: string;
  blurValue: string;
  language: string;
}

let config: AppConfig = {
  apiKey: '',
  model: 'x-ai/grok-4-fast:free',
  theme: 'liquid', // Default theme
  expandedHeight: 600, // Default height
  dotOpacity: 0.8,
  primaryColor: '#3742fa',
  textColor: '#e0e0e0',
  bgColor: '#ffffff',
  borderColor: '#ffffff',
  buttonBg: '#ffffff',
  blurValue: '40px',
  language: 'en',
};

const themes = ['dark', 'onyx', 'liquid', 'hot-orange']; // ++ Added 'hot-orange'

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

// ++ Refactored to handle the entire config object ++
function loadConfig() {
  try {
    const configDir = path.join(app.getPath('userData'), 'config');
    const configPath = path.join(configDir, 'config.json');
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    if (fs.existsSync(configPath)) {
      const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = { ...config, ...savedConfig };
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

// ++ Refactored to save the entire config object ++
function saveConfig(newConfig: Partial<AppConfig>) {
  try {
    const configDir = path.join(app.getPath('userData'), 'config');
    const configPath = path.join(configDir, 'config.json');
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    config = { ...config, ...newConfig };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    if (mainWindow) {
        // Send the full updated config back to the renderer
        mainWindow.webContents.send('config-updated', config);
    }
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}


async function analyzeContent(content: string, isAction = false): Promise<string> {
  if (!config.apiKey) {
    return 'No OpenRouter API key set. Press F1 to configure.';
  }

  try {
    // ++ Updated system prompt with new 'run_command' and 'open_app' actions ++
    const languagePrompt = config.language === 'sv' ? 'Respond in Swedish.' : 'Respond in English.';
    const systemPrompt = isAction
      ? `You are a helpful AI assistant on Linux (Manjaro). ${languagePrompt} For any actionable request (commands, opening apps/URLs, searching, copying, replacing text, or analysis), ALWAYS respond with valid JSON ONLY: {"action": "exact_name", "params": {}}. NO plain text, explanations, or Markdown outside JSON. If the request is to replace or edit clipboard text, use "replace_text" with {"newText": "the exact replacement text"}. Actions: "run_command" {"command": "full bash command, e.g. 'ls -la'"}, "open_url" {"url": "https://..."}, "search_web" {"query": "search term"}, "copy_text" {"text": "text to copy"}, "analysis" {"analysis": "detailed Markdown response"}, "open_app" {"appName": "e.g. firefox"}, "replace_text" {"newText": "replacement for clipboard"}. For non-actions, respond with plain text analysis.`
      : `You are a helpful study assistant. ${languagePrompt} Analyze the provided content and provide a clear, concise summary using Markdown for formatting (headings, lists, bold text). If it's a quiz or study material, explain key concepts and provide helpful insights. Keep responses focused and educational.`;

    const userPrompt = isAction 
      ? `Process this user request: ${content}`
      : `Please analyze and summarize this content:\n\n${content}`;

    const response = await axios.post(
      `${OPENROUTER_API_URL}/chat/completions`,
      {
        model: config.model, // ++ Use model from config
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      },
      {
        timeout: 15000, // 15 second timeout for faster failure
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/yourusername/dynamic-island-app', // Replace with your repo if you have one
          'X-Title': 'Dynamic Island Study Assistant'
        }
      }
    );

    if (response.data.choices && response.data.choices.length > 0) {
      return response.data.choices[0].message.content;
    } else {
      throw new Error(`Invalid API response: No choices provided.`);
    }
  } catch (error) {
    console.error('OpenRouter API Error:', error);
    if (axios.isAxiosError(error) && error.response) {
      if (error.response.status === 401) return 'Invalid API key (401). Press F1 to update it.';
      if (error.response.status === 404 || error.response.status === 400) return `Model '${config.model}' not available. Press F1 to change it.`;
    }
    return 'Network error or API unavailable. Please check your connection.';
  }
}

async function executeAction(actionData: any): Promise<string> {
  try {
    const { shell } = require('electron');
    // Typing actions disabled - nut-js deprecated

    // ++ Added 'run_command' and 'open_app' actions ++
    if (actionData.action === 'run_command') {
      const command = actionData.params.command;
      console.log('Executing command:', command);
      try {
        const { stdout, stderr } = await execAsync(command);
        console.log('Command stdout:', stdout);
        if (stderr) console.log('Command stderr:', stderr);
        let result = `Executed: ${command}`;
        if (stdout.trim()) {
          result += `\n\nOutput:\n${stdout}`;
        }
        if (stderr.trim()) {
          result += `\n\nErrors:\n${stderr}`;
        }
        return result;
      } catch (error) {
        console.error('Command execution error:', error);
        return `Error executing "${command}": ${(error as Error).message}`;
      }
    } else if (actionData.action === 'open_app') {
        const appName = actionData.params.appName;
        let command = '';
        if (process.platform === 'win32') {
            command = `start ${appName}`;
        } else if (process.platform === 'darwin') {
            command = `open -a "${appName}"`;
        } else {
            command = `xdg-open "${appName}" || ${appName}`; // Better for Linux
        }
        console.log('Opening app with command:', command);
        try {
          const { stdout, stderr } = await execAsync(command);
          let result = `Opened: ${appName}`;
          if (stdout.trim()) {
            result += `\n\nOutput:\n${stdout}`;
          }
          if (stderr.trim()) {
            result += `\n\nErrors:\n${stderr}`;
          }
          return result;
        } catch (error) {
          console.error('App open error:', error);
          return `Error opening "${appName}": ${(error as Error).message}`;
        }
    } else if (actionData.action === 'play_music') {
      const query = encodeURIComponent(actionData.params.query);
      shell.openExternal(`https://music.youtube.com/search?q=${query}`);
      return `Playing: ${actionData.params.query}`;
    } else if (actionData.action === 'copy_text') {
      clipboard.writeText(actionData.params.text);
      return `Copied: ${actionData.params.text.substring(0, 50)}...`;
    } else if (actionData.action === 'analysis') {
      return actionData.params.analysis || 'No analysis provided.';
    } else if (actionData.action === 'open_url') {
      const url = actionData.params.url;
      if (url && url.startsWith('http')) {
        await shell.openExternal(url);
        return `Opened: ${url}`;
      }
      return 'Invalid URL provided.';
    } else if (actionData.action === 'search_web') {
      const query = encodeURIComponent(actionData.params.query);
      await shell.openExternal(`https://www.google.com/search?q=${query}`);
      return `Searching: ${actionData.params.query}`;
    }
    return 'Action completed.';
  } catch (error) {
    console.error('Action execution error:', error);
    return `Error executing action: ${(error as Error).message}.`;
  }
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 200,
    height: 35,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false, // ++ Disable red underline in inputs
    }
  });

  primaryDisplay = electronScreen.getPrimaryDisplay();
  screenWidth = primaryDisplay.workAreaSize.width;
  const initialLeft = Math.floor((screenWidth - 200) / 2);
  mainWindow.setPosition(initialLeft, 0);
  centerX = Math.floor(screenWidth / 2);

  mainWindow.on('resize', () => {
    if (mainWindow) {
      const bounds = mainWindow.getBounds();
      const newLeft = Math.floor((screenWidth - bounds.width) / 2);
      mainWindow.setBounds({ x: newLeft, y: 0, width: bounds.width, height: bounds.height });
    }
  });

  mainWindow.on('move', () => {
    if (mainWindow) {
      const bounds = mainWindow.getBounds();
      const newLeft = Math.floor((screenWidth - bounds.width) / 2);
      mainWindow.setBounds({ x: newLeft, y: 0, width: bounds.width, height: bounds.height });
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setIgnoreMouseEvents(false);
}

app.whenReady().then(() => {
  loadConfig(); // Load config on startup
  createWindow();

  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (mainWindow) {
        // Send initial config to renderer
        mainWindow.webContents.send('config-updated', config);
      }
    });
  }

  let clipboardInterval = setInterval(() => {
    const newContent = clipboard.readText();
    if (newContent !== copiedContent && newContent.trim()) {
      copiedContent = newContent;
      mainWindow?.webContents.send('content-copied', newContent);
    }
  }, 500);

  // -- Shortcuts Refactored --
  const retAnalyze = globalShortcut.register('Alt+C', async () => {
    const content = clipboard.readText();
    if (content.trim()) {
      if (mainWindow) {
        mainWindow.webContents.send('analyzing');
        const analysis = await analyzeContent(content);
        mainWindow.webContents.send('analysis-complete', analysis);
      }
    } else if (mainWindow) {
        mainWindow.webContents.send('analysis-complete', 'Clipboard is empty. Copy some text and try again.');
    }
  });
  
  if (!retAnalyze) {
    console.log('Shortcut registration failed');
  }

  app.on('will-quit', () => {
    clearInterval(clipboardInterval);
    if (fullscreenInterval) clearInterval(fullscreenInterval);
    globalShortcut.unregisterAll();
  });

  // F1 shortcut to expand from dot mode
  const f1Shortcut = globalShortcut.register('F1', () => {
    if (mainWindow) {
      mainWindow.webContents.send('expand-from-dot');
    }
  });

  if (!f1Shortcut) {
    console.log('F1 shortcut registration failed');
  }

  // Fullscreen detection polling (Linux-specific using xdotool)
  let fullscreenInterval: NodeJS.Timeout | null = null;
  let isHiddenForFullscreen = false;

  function checkFullscreen() {
    if (!mainWindow || process.platform !== 'linux') return;

    exec('xdotool getactivewindow getwindowgeometry --shell', (error, stdout) => {
      if (error) return;

      const lines = stdout.split('\n');
      const widthMatch = lines.find(line => line.startsWith('GEOMETRY'));
      if (widthMatch) {
        const [_, width, height, x, y] = widthMatch.match(/GEOMETRY:(\d+)x(\d+)\+(\d+)\+(\d+)/) || [];
        if (width && height && parseInt(width) === screenWidth && parseInt(height) === primaryDisplay.workAreaSize.height) {
          // Active window is fullscreen
          if (!isHiddenForFullscreen && mainWindow && mainWindow.isVisible()) {
            isHiddenForFullscreen = true;
            mainWindow.hide();
          }
        } else {
          // Not fullscreen
          if (isHiddenForFullscreen && mainWindow && !mainWindow.isVisible()) {
            isHiddenForFullscreen = false;
            mainWindow.show();
            mainWindow.focus();
          }
        }
      }
    });
  }

  if (process.platform === 'linux') {
    fullscreenInterval = setInterval(checkFullscreen, 500); // Poll every 500ms
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// -- IPC Handlers --
ipcMain.on('close-analysis', () => {
  if (mainWindow) mainWindow.webContents.send('reset-island');
});

ipcMain.on('quit-app', () => { // ++ To close the app
    app.quit();
});

ipcMain.on('resize-window', (_event, { width, height }: { width: number; height: number }) => {
  if (mainWindow) {
    setTimeout(() => {
      const newLeft = Math.floor((screenWidth - width) / 2);
      if (mainWindow) {
        mainWindow.setBounds({ x: newLeft, y: 0, width, height });
        mainWindow.focus();
      }
    }, 50);
  }
});

ipcMain.on('analyze-speech', async (_event, content: string) => {
  speechContent = content;
  if (mainWindow) {
    mainWindow.webContents.send('analyzing');
    const analysis = await analyzeContent(`Analyze this spoken query: ${content}`);
    mainWindow.webContents.send('analysis-complete', analysis);
  }
});

ipcMain.on('ask-ai', async (_event, query: string) => {
  if (mainWindow) {
    mainWindow.webContents.send('analyzing');
    const userPromptWithClipboard = copiedContent.trim() ? `The current clipboard/highlighted text is: "${copiedContent}". User request: ${query}` : query;
    const response = await analyzeContent(userPromptWithClipboard, true);
    try {
      const actionData = JSON.parse(response);
      const silentActions = ['play_music', 'open_url', 'type_text', 'copy_text', 'search_web', 'run_command', 'open_app'];
      if (actionData.action === 'replace_text') {
        mainWindow.webContents.send('text-replacement', { oldText: copiedContent, newText: actionData.params.newText });
      } else if (silentActions.includes(actionData.action)) {
        const result = await executeAction(actionData);
        if (actionData.action === 'run_command') {
          mainWindow.webContents.send('analysis-complete', result);
        } else {
          mainWindow.webContents.send('action-completed', result);
        }
      } else if (actionData.action === 'analysis') {
        mainWindow.webContents.send('analysis-complete', actionData.params.analysis);
      } else {
        mainWindow.webContents.send('ask-complete', actionData.response || 'Action completed.');
      }
    } catch (parseError) {
      mainWindow.webContents.send('ask-complete', response);
    }
  }
});

// ++ New handler for saving the entire config object ++
ipcMain.on('save-settings', (_event, settings: AppConfig) => {
  saveConfig(settings);
});

ipcMain.on('confirm-replacement', async (_event, newText: string) => {
  try {
    clipboard.writeText(newText);
    // Cut highlighted text (Ctrl+X) then paste (Ctrl+V)
    await nutKeyboard.pressKey(Key.LeftControl, Key.X);
    await nutKeyboard.releaseKey(Key.LeftControl, Key.X);
    await nutKeyboard.pressKey(Key.LeftControl, Key.V);
    await nutKeyboard.releaseKey(Key.LeftControl, Key.V);
  } catch (error) {
    console.error('Replacement error:', error);
  }
});
