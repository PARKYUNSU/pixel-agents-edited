import { useEffect, useRef, useState } from 'react';

import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';
import { Button } from './ui/Button.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  workspaceFolders: WorkspaceFolder[];
}

export function BottomToolbar({
  isEditMode,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  workspaceFolders,
}: BottomToolbarProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const pendingBypassRef = useRef(false);
  const pendingProviderRef = useRef<'claude' | 'gemini' | 'ollama'>('claude');

  useEffect(() => {
    if (!isFolderPickerOpen && !isProviderMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false);
        setIsProviderMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isProviderMenuOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const postOpenAgent = (
    provider: 'claude' | 'gemini' | 'ollama',
    bypassPermissions: boolean,
    folderPath?: string,
  ) => {
    vscode.postMessage({
      type: 'openClaude',
      provider,
      bypassPermissions: provider === 'claude' && bypassPermissions ? true : undefined,
      folderPath,
    });
  };

  const handleProviderSelect = (
    provider: 'claude' | 'gemini' | 'ollama',
    bypassClaudePermissions: boolean,
  ) => {
    setIsProviderMenuOpen(false);
    if (hasMultipleFolders) {
      pendingProviderRef.current = provider;
      pendingBypassRef.current = provider === 'claude' && bypassClaudePermissions;
      setIsFolderPickerOpen(true);
    } else {
      postOpenAgent(provider, bypassClaudePermissions);
    }
  };

  const handleAgentClick = () => {
    setIsFolderPickerOpen(false);
    setIsProviderMenuOpen((v) => !v);
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    const bypass = pendingBypassRef.current;
    const provider = pendingProviderRef.current;
    pendingBypassRef.current = false;
    postOpenAgent(provider, bypass, folder.path);
  };

  return (
    <div className="absolute bottom-10 left-10 z-20 flex items-center gap-4 pixel-panel p-4">
      <div ref={folderPickerRef} className="relative">
        <Button
          variant="accent"
          onClick={handleAgentClick}
          className={
            isFolderPickerOpen || isProviderMenuOpen
              ? 'bg-accent-bright'
              : 'bg-accent hover:bg-accent-bright'
          }
        >
          + Agent
        </Button>
        <Dropdown isOpen={isProviderMenuOpen} className="min-w-128">
          <DropdownItem onClick={() => handleProviderSelect('claude', false)} className="text-base">
            Claude Code
          </DropdownItem>
          <DropdownItem onClick={() => handleProviderSelect('claude', true)} className="text-base">
            Claude Code — skip permissions <span className="text-2xs text-warning">⚠</span>
          </DropdownItem>
          <DropdownItem onClick={() => handleProviderSelect('gemini', false)} className="text-base">
            Gemini
          </DropdownItem>
          <DropdownItem onClick={() => handleProviderSelect('ollama', false)} className="text-base">
            Ollama
          </DropdownItem>
        </Dropdown>
        <Dropdown isOpen={isFolderPickerOpen} className="min-w-128">
          {workspaceFolders.map((folder) => (
            <DropdownItem
              key={folder.path}
              onClick={() => handleFolderSelect(folder)}
              className="text-base"
            >
              {folder.name}
            </DropdownItem>
          ))}
        </Dropdown>
      </div>
      <Button
        variant={isEditMode ? 'active' : 'default'}
        onClick={onToggleEditMode}
        title="Edit office layout"
      >
        Layout
      </Button>
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
    </div>
  );
}
