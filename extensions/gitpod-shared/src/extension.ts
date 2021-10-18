/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createGitpodExtensionContext, GitpodExtensionContext, registerDefaultLayout, registerNotifications, registerWorkspaceCommands, registerWorkspaceSharing, registerWorkspaceTimeout } from './features';
import * as uuid from 'uuid';

export { GitpodExtensionContext, SupervisorConnection, registerTasks } from './features';
export * from './gitpod-plugin-model';

export async function setupGitpodContext(context: vscode.ExtensionContext): Promise<GitpodExtensionContext | undefined> {
	if (typeof vscode.env.remoteName === 'undefined' || context.extension.extensionKind !== vscode.ExtensionKind.Workspace) {
		return undefined;
	}

	const gitpodContext = await createGitpodExtensionContext(context);
	if (!gitpodContext) {
		vscode.commands.executeCommand('setContext', 'gitpod.inWorkspace', false);
		return undefined;
	}
	vscode.commands.executeCommand('setContext', 'gitpod.inWorkspace', true);

	vscode.commands.executeCommand('setContext', 'gitpod.ideAlias', gitpodContext.info.getIdeAlias());
	if (vscode.env.uiKind === vscode.UIKind.Web) {
		vscode.commands.executeCommand('setContext', 'gitpod.UIKind', 'web');
	} else if (vscode.env.uiKind === vscode.UIKind.Desktop) {
		vscode.commands.executeCommand('setContext', 'gitpod.UIKind', 'desktop');
	}

	registerUsageAnalytics(gitpodContext);
	registerWorkspaceCommands(gitpodContext);
	registerWorkspaceSharing(gitpodContext);
	registerWorkspaceTimeout(gitpodContext);
	registerNotifications(gitpodContext);
	registerDefaultLayout(gitpodContext);
	return gitpodContext;
}

export enum GitpodAnalyticsEvent {
	VSCodeSession = 'vscode_session',
	VSCodeOnDidOpenTerminal = 'vscode_did_open_terminal',
	VSCodeExecuteCommandGitpodOpenDashboard = 'vscode_execute_command_gitpod_open_dashboard',
	VSCodeExecuteCommandGitpodOpenAccessControl = 'vscode_execute_command_gitpod_open_accesscontrol',
	VSCodeExecuteCommandGitpodOpenSettings = 'vscode_execute_command_gitpod_open_settings',
	VSCodeExecuteCommandGitpodOpenContext = 'vscode_execute_command_gitpod_open_context',
	VSCodeExecuteCommandGitpodOpenDocumentation = 'vscode_execute_command_gitpod_open_documentation',
	VSCodeExecuteCommandGitpodOpenTwitter = 'vscode_execute_command_gitpod_open_twitter',
	VSCodeExecuteCommandGitpodOpenDiscord = 'vscode_execute_command_gitpod_open_discord',
	VSCodeExecuteCommandGitpodOpenDiscourse = 'vscode_execute_command_gitpod_open_discourse',
	VSCodeExecuteCommandGitpodOpenIssue = 'vscode_execute_command_gitpod_open_issue',
	VSCodeExecuteCommandGitpodOpenInStable = 'vscode_execute_command_gitpod_open_in_stable',
	VSCodeExecuteCommandGitpodOpenInInsiders = 'vscode_execute_command_gitpod_open_in_insiders',
	VSCodeExecuteCommandGitpodOpenInBrowser = 'vscode_execute_command_gitpod_open_in_browser',
	VSCodeExecuteCommandGitpodStopWorkspace = 'vscode_execute_command_gitpod_stop_workspace',
	VSCodeExecuteCommandGitpodUpgradeSubscription = 'vscode_execute_command_gitpod_upgrade_subscription',
	VSCodeExecuteGitpodCommandTakeSnapshot = 'vscode_execute_command_gitpod_take_snapshot',
	VSCodeExecuteCommandGitpodShareWorkspace = 'vscode_execute_command_gitpod_share_workspace',
	VSCodeExecuteCommandGitpodStopSharingWorkspace = 'vscode_execute_command_gitpod_stop_sharing_workspace',
	VSCodeExecuteCommandGitpodExtendTimeout = 'vscode_execute_command_gitpod_extend_timeout',
	VSCodeExecuteGitpodCommandPortsMakePrivate = 'vscode_execute_command_gitpod_ports_make_private',
	VSCodeExecuteGitpodCommandPortsMakePublic = 'vscode_execute_command_gitpod_ports_make_public',
	VSCodeExecuteGitpodCommandPortsOpenPreview = 'vscode_execute_command_gitpod_ports_open_preview',
	VSCodeExecuteGitpodCommandPortsOpenBrowser = 'vscode_execute_command_gitpod_ports_open_browser',
	VSCodeExecuteGitpodCommandAddToConfig = 'vscode_execute_command_gitpod_add_to_config',
	VSCodeExecuteGitpodCommandRemoveFromConfig = 'vscode_execute_command_gitpod_remove_from_config',
}

export function getAnalyticsEvent(context: GitpodExtensionContext) {
	const sessionId = uuid.v4();
	const properties = {
		sessionId,
		workspaceId: context.info.getWorkspaceId(),
		instanceId: context.info.getInstanceId(),
		appName: vscode.env.appName,
		uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
		devMode: context.devMode,
		version: vscode.version,
	};
	return function (eventName: GitpodAnalyticsEvent, phase?: 'start' | 'running' | 'end'): Promise<void> {
		const args = {
			event: eventName,
			properties: {
				...properties,
				timestamp: Date.now(),
				focused: vscode.window.state.focused,
				phase,
			}
		};
		// TODO: Consider doing this via env variable, also.
		if (context.devMode && vscode.env.uiKind === vscode.UIKind.Web) {
			console.log('ANALYTICS:', args);
			return Promise.resolve();
		} else {
			return context.gitpod.server.trackEvent(args);
		}

	};
}

function registerUsageAnalytics(context: GitpodExtensionContext): void {
	const fireAnalyticsEvent = getAnalyticsEvent(context);
	fireAnalyticsEvent(GitpodAnalyticsEvent.VSCodeSession, 'start');
	context.subscriptions.push(vscode.window.onDidChangeWindowState(() => fireAnalyticsEvent(GitpodAnalyticsEvent.VSCodeSession, 'running')));
	context.subscriptions.push(vscode.window.onDidOpenTerminal(() => fireAnalyticsEvent(GitpodAnalyticsEvent.VSCodeOnDidOpenTerminal)));
	context.pendingWillCloseSocket.push(() => fireAnalyticsEvent(GitpodAnalyticsEvent.VSCodeSession, 'end'));
}

