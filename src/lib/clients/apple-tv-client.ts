
import { DeviceConfiguration } from '../configuration/device-configuration';
import { Platform } from '../platform';
import * as AppleTv from 'node-appletv-x';
import { EventEmitter } from 'events';
import { Usage } from './usage';

/**
 * Represents a client that communicates with an Apple TV.
 */
export class AppleTvClient extends EventEmitter {

    /**
     * Initializes a new AppleTvClient instance.
     * @param platform The platform of the plugin.
     * @param deviceConfiguration The configuration of the device with which the client should communicate.
     */
    constructor(private platform: Platform, private deviceConfiguration: DeviceConfiguration) {
        super();

        // Sets the user-defined name
        this.name = deviceConfiguration.name;

        // Parses the credentials in order to extract the unique ID of the hardware
        this.id = AppleTv.parseCredentials(deviceConfiguration.credentials).uniqueIdentifier;
    }

    /**
     * Contains the currently open connection to the Apple TV.
     */
    private appleTv: AppleTv.AppleTV|null = null;

    /**
     * Contains the handle for the interval that executes the heartbeat command.
     */
    private heartbeatIntervalHandle: any = null;

    /**
     * Sends a heartbeat message to the Apple TV.
     */
    private async sendHeartbeatAsync(): Promise<void> {
        this.platform.logger.debug(`[${this.name}] Sending heartbeat...`);

        // Tries to connect to the Apple TV
        try {
            await this.connectAsync(false);
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Error while connecting for heartbeat: ${e}`);
            return;
        }
        
        // Tries to send the heartbeat message
        try {
            
            // Sends the introduction message as a heartbeat
            await this.appleTv!.sendIntroduction();
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Error while sending heartbeat: Socket closed.`);
            this.appleTv = null;
        }
    }

    /**
     * Tries to get the on/off state of the Apple TV.
     * @param messagePayload The message payload that contains the information to check whether the Apple TV is on.
     * @returns Returns a value that determines whether the Apple TV is on.
     */
    private getIsOn(messagePayload: any): boolean {

        // If the Apple TV is not a proxy for AirPlay playback, the logicalDeviceCount determines the state
        if (messagePayload.logicalDeviceCount > 0 && !messagePayload.isProxyGroupPlayer) {
            return true;
        }

        // If the Apple TV is a proxy for AirPlay playback, the logicalDeviceCount and the AirPlay state determine the state
        if (messagePayload.logicalDeviceCount > 0 && messagePayload.isProxyGroupPlayer && messagePayload.isAirplayActive) {
            return true;
        }
        return false;
    }

    /**
     * Tries to get the play/pause state of the Apple TV.
     * @param messagePayload The message payload that contains the information to check whether the Apple TV is playing.
     * @returns Returns a value that determines whether the Apple TV is playing.
     */
    private getIsPlaying(messagePayload: any): boolean {

        // Gets the new playing state
        return messagePayload.playbackState == 1;
    }

    /**
     * Tries to connect to an Apple TV.
     * @param forceReconnect Determines whether a reconnect should happen even if the Apple TV is already connected.
     * @param retryCount The number of retries that are left.
     */
    public async connectAsync(forceReconnect: boolean, retryCount?: number): Promise<void> {
        this.platform.logger.debug(`[${this.name}] Connecting...`);

        // Set the default retry count
        if (!retryCount) {
            retryCount = this.platform.configuration.maximumConnectRetry;
        }
        this.platform.logger.debug(`[${this.name}] Force reconnect: ${forceReconnect}`);
        this.platform.logger.debug(`[${this.name}] Retry count: ${retryCount}`);

        // Checks if connection if already open
        if (this.appleTv && !forceReconnect) {
            this.platform.logger.debug(`[${this.name}] Already connected`)
            return;
        }

        // Checks if a previous connection should be closed
        if (this.appleTv) {
            this.disconnect();
        }

        // Tries to connect to the Apple TV
        try {
            
            // Scans the network for the Apple TV
            this.platform.logger.debug(`[${this.name}] Scanning for Apple TV...`);
            const appleTvs = await AppleTv.scan(undefined, this.platform.configuration.scanTimeout);

            // Checks if the Apple TV has been found
            const uniqueIdentifier = AppleTv.parseCredentials(this.deviceConfiguration.credentials).uniqueIdentifier;
            const appleTv = appleTvs.find(a => a.uid == uniqueIdentifier);
            if (!appleTv) {
                throw new Error('Apple TV not found while scanning.');
            }

            // Subscribes for messages if events are enabled
            if (this.areEventsEnabled) {
                appleTv.on('message', (m: AppleTv.Message) => {
                    if (m.payload) {

                        // Updates the power state
                        if (m.payload.logicalDeviceCount === 0 || m.payload.logicalDeviceCount > 0) {
                            this.platform.logger.debug(`[${this.name}] Message received: logicalDeviceCount - ${m.payload.logicalDeviceCount} | isProxyGroupPlayer - ${m.payload.isProxyGroupPlayer} | isAirplayActive - ${m.payload.isAirplayActive} | isGroupLeader - ${m.payload.isGroupLeader} | airplayReceivers - ${m.payload.airplayReceivers}`);
                            this.updateIsOn(this.getIsOn(m.payload));

                            // If the Apple TV has switched off, the play state should also be off
                            if (!this.getIsOn(m.payload)) {
                                this.updateIsPlaying(false);
                            }
                        }

                        // Updates the playback state
                        if (m.payload.playbackState) {
                            this.platform.logger.debug(`[${this.name}] Message received: playbackState - ${m.payload.playbackState} app - ${m.payload.playerPath?.client?.bundleIdentifier}`);
                            
                            const currentApp = m.payload.playerPath?.client?.bundleIdentifier;
                            
                            // Sends another heartbeat if the playback state changed
                            if (this.isPlaying !== this.getIsPlaying(m.payload) || this._currentApp !== currentApp) {
                                this.sendHeartbeatAsync();
                            }

                            // Updates current app
                            if(m.payload.playerPath?.client?.bundleIdentifier){
                                this._currentApp = currentApp;
                                this.platform.logger.info(`[${this.name}] Current bundleIdentifier is now: ${m.payload.playerPath?.client?.bundleIdentifier}`);
                            }
                        
                            // Updates the play state
                            this.updateIsPlaying(this.getIsPlaying(m.payload));
                        } 
                    }
                });
            }

            // Subscribes for closed socket
            appleTv.on('close', () => this.appleTv = null);

            // Opens the connection to the found Apple TV
            this.platform.logger.debug(`[${this.name}] Connecting to Apple TV...`);
            await appleTv.openConnection(AppleTv.parseCredentials(this.deviceConfiguration.credentials));
            this.appleTv = appleTv;
            this.platform.logger.info(`[${this.name}] Connected`);
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Error while connecting: ${e}`);

            // Decreased the retry count and tries again
            retryCount--;
            if (retryCount > 0) {
                await new Promise(resolve => setTimeout(resolve, this.platform.configuration.connectRetryInterval * 1000));
                await this.connectAsync(true, retryCount);
            } else {
                throw e;
            }
        }
    }

    /**
     * Disconnects from the Apple TV.
     */
    public disconnect() {
        this.platform.logger.debug(`[${this.name}] Disconnecting...`);

        // Tries to close the connection
        try {
            if (this.appleTv) {
                this.appleTv.closeConnection();
            } else {
                this.platform.logger.debug(`[${this.name}] Already disconnected`);
            }
        } finally {
            this.appleTv = null;
        }
    }

    /**
     * Gets or sets the unique ID of the Apple TV.
     */
    public id: string;

    /**
     * Gets or sets the name of the Apple TV.
     */
    public name: string;

    /**
     * Contains a value that determines whether events are emitted when the status of the Apple TV changes.
     */
    private _areEventsEnabled = false;

    /**
     * Gets a value that determines whether events are emitted when the status of the Apple TV changes.
     */
    public get areEventsEnabled(): boolean {
        return this._areEventsEnabled;
    }

    /**
     * Sets a value that determines whether events are emitted when the status of the Apple TV changes.
     */
    public set areEventsEnabled(value: boolean) {
        this._areEventsEnabled = value;

        // Checks if events are disabled
        if (!value) {

            // Clears the interval
            if (this.heartbeatIntervalHandle) {
                clearInterval(this.heartbeatIntervalHandle);
                this.heartbeatIntervalHandle = null;
            }

            // Disconnects from the Apple TV
            this.disconnect();
            return;
        }

        // Sets the heartbeat interval
        this.sendHeartbeatAsync();
        this.heartbeatIntervalHandle = setInterval(() => this.sendHeartbeatAsync(), this.platform.configuration.heartbeatInterval * 1000);
    }

    /**
     * Contains a value that determines whether the Apple TV is powered on.
     */
    private _isOn: boolean = false;

    /**
     * Gets a value that determines whether the Apple TV is powered on.
     */
    public get isOn(): boolean {
        return this._isOn;
    }

    /**
     * Contains the timeout handle which is used to prevent flickering of the on state (which appears if the Apple TV switches its state and does report an unstable state).
     * This mechanism is "dampening" the state.
     */
    private updateIsOnTimeoutHandle: any = null;

    /**
     * Updates the on/off state.
     * @param value The new value of the on/off state.
     */
    private updateIsOn(value: boolean) {
        this.platform.logger.debug(`[${this.name}] Update power state to ${value}`);

        // If the handle is not null, this means that the last change is less than X seconds ago
        // In this case, the update of the state cannot be safely done, as it is seen as unstable
        if (this.updateIsOnTimeoutHandle) {
            this.platform.logger.debug(`[${this.name}] Update power state to ${value}: dampening`);

            // Clears the previous timeout and sets the new one for the updated value
            clearTimeout(this.updateIsOnTimeoutHandle);
            this.updateIsOnTimeoutHandle = setTimeout(() => {
                this.platform.logger.debug(`[${this.name}] Update power state to ${value}: dampening timeout elapsed`);
                clearTimeout(this.updateIsOnTimeoutHandle);
                this.updateIsOnTimeoutHandle = null;

                // Calls the update method again
                this.updateIsOn(value);
            }, this.platform.configuration.isOnDampeningTimeout * 1000);
            return;
        }

        // Checks if the value actually differs from the current value
        if (this._isOn === value) {
            this.platform.logger.debug(`[${this.name}] Update power state to ${value}: value not changed`);
            return;
        }

        // Updates the current value
        this._isOn = value;
        this.emit('isOnChanged');

        // Creates a new timeout to prevent changes of the value within the next X seconds
        this.platform.logger.debug(`[${this.name}] Update power state to ${value}: value changed`);
        this.updateIsOnTimeoutHandle = setTimeout(() => {
            clearTimeout(this.updateIsOnTimeoutHandle);
            this.updateIsOnTimeoutHandle = null;
        }, this.platform.configuration.isOnDampeningTimeout * 1000);
    }

    /**
     * Gets a value that determines whether the Apple TV is powered on.
     * @param retryCount The number of retries that are left.
     */
    public async isOnAsync(retryCount?: number): Promise<boolean> {
        this.platform.logger.info(`[${this.name}] Getting power state...`);

        // If events are enabled, the value is already cached
        if (this.areEventsEnabled) {
            this.platform.logger.info(`[${this.name}] Returning cached value ${this.isOn} for power state`);
            return this.isOn;
        }

        // Set the default retry count
        if (!retryCount) {
            retryCount = this.platform.configuration.maximumConnectRetry;
        }

        // Tries to connect to the Apple TV
        try {
            await this.connectAsync(false);
        } catch (e) {
            throw e;
        }
        
        // Tries to get the value
        let message: AppleTv.Message;
        try {
            
            // Sends the introduction message, which returns the device info with the logical device count information
            message = await this.appleTv!.sendIntroduction();
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Error while getting power state: ${e}`);

            // Decreased the retry count and tries again
            retryCount--;
            if (retryCount > 0) {
                return await this.isOnAsync(retryCount);
            } else {
                throw e;
            }
        }

        // Returns the value indicating whether the device is on.
        this.platform.logger.info(`[${this.name}] Returning value ${this.getIsOn(message.payload)} for power state`);
        return this.getIsOn(message.payload);
    }

    /**
     * Contains a value that determines whether the Apple TV is playing.
     */
    private _isPlaying: boolean = false;

    /**
     * Contains the bundle identifier of the Apple TV app that reported the last playback state.
     */
    private _currentApp: string = '';

    /**
     * Gets a value that determines whether the Apple TV is playing.
     */
    public get isPlaying(): boolean {
        return this._isPlaying;
    }

    /**
     * Gets the bundle identifier of the Apple TV app that reported the last playback state.
     */
    public get currentApp(): string {
        return this._currentApp;
    }

    /**
     * Contains the timeout handle which is used to prevent flickering of the on state (which appears if the Apple TV switches its state and does report an unstable state).
     * This mechanism is "dampening" the state.
     */
    private updateIsPlayingTimeoutHandle: any = null;

    /**
     * Updates the playing state.
     * @param value The new value of the playing state.
     */
    private updateIsPlaying(value: boolean) {
        this.platform.logger.debug(`[${this.name}] Update playback state to ${value}`);

        // If the handle is not null, this means that the last change is less than X seconds ago
        // In this case, the update of the state cannot be safely done, as it is seen as unstable
        if (this.updateIsPlayingTimeoutHandle) {
            this.platform.logger.debug(`[${this.name}] Update playback state to ${value}: dampening`);

            // Clears the previous timeout and sets the new one for the updated value
            clearTimeout(this.updateIsPlayingTimeoutHandle);
            this.updateIsPlayingTimeoutHandle = setTimeout(() => {
                this.platform.logger.debug(`[${this.name}] Update playback state to ${value}: dampening timeout elapsed`);
                clearTimeout(this.updateIsPlayingTimeoutHandle);
                this.updateIsPlayingTimeoutHandle = null;

                // Calls the update method again
                this.updateIsPlaying(value);
            }, this.platform.configuration.isPlayingDampeningTimeout * 1000);
            return;
        }

        // Checks if the value actually differs from the current value
        if (this._isPlaying === value) {
            this.platform.logger.debug(`[${this.name}] Update playback state to ${value}: value not changed`);
            return;
        }

        // Updates the current value
        this._isPlaying = value;
        this.emit('isPlayingChanged');

        // Creates a new timeout to prevent changes of the value within the next X seconds
        this.platform.logger.debug(`[${this.name}] Update playback state to ${value}: value changed`);
        this.updateIsPlayingTimeoutHandle = setTimeout(() => {
            clearTimeout(this.updateIsPlayingTimeoutHandle);
            this.updateIsPlayingTimeoutHandle = null;
        }, this.platform.configuration.isPlayingDampeningTimeout * 1000);
    }

    /**
     * Gets a value that determines whether the Apple TV is playing.
     * @param retryCount The number of retries that are left.
     */
    public async getCurrentAppAsync(): Promise<string> {
        this.platform.logger.info(`[${this.name}] Getting current app...`);

        // If events are enabled, the value is already cached
        if (this.areEventsEnabled) {
            this.platform.logger.info(`[${this.name}] Returning cached value ${this.currentApp} for current app`);
            return this.currentApp;
        } else {
            return ''
        }
    };

    /**
     * Gets a value that determines whether the Apple TV is playing.
     * @param retryCount The number of retries that are left.
     */
    public async isPlayingAsync(retryCount?: number): Promise<boolean> {
        this.platform.logger.info(`[${this.name}] Getting play state...`);
        
        // If events are enabled, the value is already cached
        if (this.areEventsEnabled) {
            this.platform.logger.info(`[${this.name}] Returning cached value ${this.isPlaying} for play state`);
            return this.isPlaying;
        }

        // Set the default retry count
        if (!retryCount) {
            retryCount = this.platform.configuration.maximumConnectRetry;
        }

        // Tries to connect to the Apple TV
        try {
            await this.connectAsync(false);
        } catch (e) {
            throw e;
        }
        
        // Tries to get the value
        let nowPlayingInfo: AppleTv.NowPlayingInfo;
        try {
            
            // Requests the playback state
            nowPlayingInfo = await this.appleTv!.requestPlaybackQueue({
                location: 0,
                length: 1
              });
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Error while getting play state: ${e}`);

            // Decreased the retry count and tries again
            retryCount--;
            if (retryCount > 0) {
                return await this.isPlayingAsync(retryCount);
            } else {
                throw e;
            }
        }

        // Returns the value indicating whether the device is on.
        this.platform.logger.info(`[${this.name}] Returning value ${nowPlayingInfo.playbackState === AppleTv.NowPlayingInfo.State.Playing} for play state`);
        return nowPlayingInfo.playbackState === AppleTv.NowPlayingInfo.State.Playing;
    }

    /**
     * Switches the Apple TV on. This method does not wait for the Apple TV to respond.
     */
    public async switchOn() {
        try {
            await this.switchOnAsync();
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Giving up. Error while switching on`);
        }
    }

    /**
     * Switches the Apple TV on.
     * @param retryCount The number of retries that are left.
     */
    public async switchOnAsync(retryCount?: number): Promise<void> {
        if (!await this.isOnAsync()) {
            await this.pressKeyAsync('topmenu', false, retryCount);
        }
    }

    /**
     * Switches the Apple TV off. This method does not wait for the Apple TV to respond.
     */
    public async switchOff() {
        try {
            await this.switchOffAsync();
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Giving up. Error while switching off`);
        }
    }

    /**
     * Switches the Apple TV off.
     * @param retryCount The number of retries that are left.
     */
    public async switchOffAsync(retryCount?: number): Promise<void> {
        if (await this.isOnAsync()) {
            await this.pressKeyAsync('topmenu', true, retryCount);
            await this.pressKeyAsync('select', false, 0);
        }
    }

    /**
     * Virtually clicks on the play button. This method does not wait for the Apple TV to respond.
     */
    public async play() {
        try {
            await this.playAsync();
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Giving up. Error while sending play command`);
        }
    }

    /**
     * Virtually clicks on the play button.
     * @param retryCount The number of retries that are left.
     */
    public playAsync(retryCount?: number): Promise<void> {
        return this.pressKeyAsync('play', false, retryCount);
    }

    /**
     * Virtually clicks on the pause button. This method does not wait for the Apple TV to respond.
     */
    public async pause() {
        try {
            await this.pauseAsync();
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Giving up. Error while sending pause command`);
        }
    }

    /**
     * Virtually clicks on the pause button.
     * @param retryCount The number of retries that are left.
     */
    public pauseAsync(retryCount?: number): Promise<void> {
        return this.pressKeyAsync('pause', false, retryCount);
    }

    /**
     * Virtually clicks on the a button.
     * @param key The key to press.
     * @param retryCount The number of retries that are left.
     */
    public longPressKeyAsync(key: string, retryCount?: number): Promise<void> {
        return this.pressKeyAsync(key, true, retryCount);
    }

    /**
     * Virtually clicks on the a button.
     * @param key The key to press.
     * @param longPress Determines whether the key should be pressed long.
     * @param retryCount The number of retries that are left.
     */
    public async pressKeyAsync(key: string, longPress?: boolean, retryCount?: number): Promise<void> {
        this.platform.logger.info(`[${this.name}] Pressing key ${key}...`);

        // Checks if the key is suported
        let usage: { usePage: number, usage: number };
        try {
            usage = Usage.getByKey(key);
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Error while pressing key ${key}: key not found`);
            throw e;
        }

        // Set the default retry count
        if (!retryCount) {
            retryCount = 2;
        }

        // Tries to connect to the Apple TV
        try {
            await this.connectAsync(false);
        } catch (e) {
            throw e;
        }
        
        // Tries to press the key
        try {
            
            // Requests the playback state
            await this.appleTv!.sendKeyPress(usage.usePage, usage.usage, true);
            if (longPress)
                await new Promise(resolve => setTimeout(resolve, 1000));
            await this.appleTv!.sendKeyPress(usage.usePage, usage.usage, false);
        } catch (e) {
            this.platform.logger.warn(`[${this.name}] Error while pressing key ${key}: ${e}`);

            // Decreased the retry count and tries again
            retryCount--;
            if (retryCount > 0) {
                return await this.pressKeyAsync(key, longPress, retryCount);
            } else {
                throw e;
            }
        }
    }

    /**
     * Is called when homebridge is shut down.
     */
    public destroy() {

        // Clears the interval for the heartbeat
        this.areEventsEnabled = false;
    }
}
