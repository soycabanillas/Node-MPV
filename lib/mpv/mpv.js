'use strict';
// Child Process to module to start mpv player
var spawn = require('child_process').spawn;
var exec  = require('child_process').execSync;
// EventEmitter
var eventEmitter = require('events').EventEmitter;


// Lodash for some nice stuff
var _ = require('lodash');

// Promise the promisify getProperty
var Promise = require('promise')

// the modules with all the member functions
var commandModule = require('./_commands');
var controlModule  = require('./_controls');
var playlistModule  = require('./_playlist');
var audioModule    = require('./_audio');
var videoModule    = require('./_video');
var subtitleModule = require('./_subtitle');

// the IPC socket to communicate with mpv
var ipcInterface = require('../ipcInterface');
// Utility functions
var util = require('../util');


function mpv(options, mpv_args){

	// intialize the event emitter
	eventEmitter.call(this);

	// getProperty storage dictionary
	this.gottenProperties = {}


	// merge the user input options with the default options
	this.options = util.mergeDefaultOptions(options);


	// get the arguments to start mpv with
	this.mpv_arguments = util.mpvArguments(this.options, mpv_args);


	// observed properties
	// serves as a status object
	// can be enhanced by using the observeProperty function
	this.observed = util.observedProperties(this.options.audio_only);

	// saves the IDs of observedProperties with their propertyname
	// key: id  value: property
	this.observedIDs = {};


	// timeposition of the current song
	var currentTimePos = null;


	// start mpv instance
	// Either with the binary provided by the user or the binary found in the default path
	this.mpvPlayer = spawn((this.options.binary ? '"' + this.options.binary + '"' : 'mpv'), this.mpv_arguments);


	// set up socket
	this.socket = new ipcInterface(this.options);


	// sets the Interval to emit the current time position
	this.socket.command("observe_property", [0, "time-pos"]);
	// timeposition event listener
	this.timepositionListenerId = setInterval(function() {
		// only emit the time position if there is a file playing and it's not paused
		if(this.observed.filename && !this.observed.pause && currentTimePos != null){
			this.emit("timeposition", currentTimePos);
		}
	}.bind(this), this.options.time_update * 1000);



	// private member method
	// will observe all properties defined in the observed JSON dictionary
	var observeProperties = function() {
		var id = 1;
		// for every property stored in observed
		Object.keys(this.observed).forEach(function (property) {
			// safety check
			if(this.observed.hasOwnProperty(property)){
				this.observeProperty(property, id);
				this.observedIDs[id] = property;
				id += 1;
			}
		}.bind(this));
	}.bind(this);
	// observe all properties defined by default
	observeProperties();


	// ### Events ###

	// if mpv crashes restart it again
	this.mpvPlayer.on('close', function respawn() {

		if(this.options.debug){
			console.log("MPV Player seems to have died. Restarting...");
		}

		// restart the mpv instance
		this.mpvPlayer = spawn((this.options.binary ? this.options.binary : 'mpv'), this.mpv_arguments);


		this.mpvPlayer.on('close', respawn.bind(this));

		// TODO: reset ALL default parameters
		currentTimePos = null;
		// a small timeout is required to wait for mpv to have restarted
		// on weak machines this could take a while, thus 1000ms
		setTimeout(function() {
			// reobserve all observed properties
			// this will include those added by the user
			observeProperties();
			// observe timeposition
			this.socket.command("observe_property", [0, "time-pos"]);
		}.bind(this), 1000);
	}.bind(this));

	// if spawn fails to start mpv player
	this.mpvPlayer.on('error', function(error) {
		if(this.options.debug){
			console.log(error);
		}
	}.bind(this));

	// handles the data received from the IPC socket
	this.socket.on('message', function(data) {
		// console.log("Message: " + JSON.stringify(data));
		// handle events
		if(data.hasOwnProperty("event")){

			// if verbose was specified output the event
			// property-changes are output in the statuschange emit
			if(this.options.verbose ){
				if(data.hasOwnProperty("event")){
					if(!(data.event === "property-change")){
						console.log("Message received: " + JSON.stringify(data));
					}
				}
				else{
					console.log("Message received: " + JSON.stringify(data));
				}
			}


			switch(data.event) {
				case "idle":
					if(this.options.verbose){console.log("Event: stopped")};
					// emit stopped event
					this.emit("stopped");
					break;
				case "playback-restart":
					if(this.options.verbose){console.log("Event: start")};
					// emit play event
					this.emit("started");
					break;
				case "pause":
					if(this.options.verbose){console.log("Event: pause")};
					// emit paused event
					this.emit("paused");
					break;
				case "unpause":
					if(this.options.verbose){console.log("Event: unpause")};
					// emit unpaused event
					this.emit("resumed");
					break;
				// observed properties
				case "property-change":
					// time position events are handled seperately
					if(data.name === "time-pos"){
						// set the current time position
						currentTimePos = data.data;
						break;
					}
					else{
						// updates the observed value or adds it, if it was previously unobserved
						this.observed[data.name] = data.data;
						// emit a status change event
						this.emit('statuschange', this.observed);
						// output if verbose
						if(this.options.verbose){
							console.log("Event: statuschange");
							console.log("Property change: " + data.name + " - " + data.data);
						}
						break;
					}
				default:

			}

		}
		// this API assumes that only get_property requests will have a request_id
		else if(data.hasOwnProperty("request_id")){

			// output if verbose
			if(this.options.verbose){
				console.log("Get Request: " + data.request_id + " - " + data.data);
			}

			// This part is strongly coupled to the getProperty method in _commands.js

			// Promise Way
			// gottenProperties[data.request_id] was already set to the resolve function
			if(this.gottenProperties[data.request_id]){
				// store the retrieved property inside the gottenProperties dictionary
				// this will resolve the promise in getProperty (_command.js)
				this.gottenProperties[data.request_id](data.data);
				// delete the entry from the gottenProperties dictionary
				delete this.gottenProperties[data.request_id];
			}
			// Non Promise Way
			else{
				// emit a getRequest event
				this.emit("getrequest", data.request_id, data.data);
			}

		}


	}.bind(this));




}

mpv.prototype = _.extend({
	constructor: mpv,

	// loads a file into mpv
	// mode
	// replace          replace current video
	// append          append to playlist
	// append-play  append to playlist and play, if the playlist was empty
	loadFile: function(file, mode) {
		mode = mode || "replace";
		this.socket.command("loadfile", [file, mode]);
	},
	// loads a stream into mpv
	// mode
	// replace          replace current video
	// append          append to playlist
	// append-play  append to playlist and play, if the playlist was empty
	loadStream: function(url, mode) {
		mode = mode || "replace";
		this.socket.command("loadfile", [url, mode]);
	}

// add all the other modules using lodash
}, controlModule, commandModule, playlistModule, audioModule, videoModule, subtitleModule, eventEmitter.prototype); // inherit from EventEmitter


// export the mpv class as the module
module.exports = mpv;
