//TODO fix online on dc already listening
import { Client } from "discord.js";
import fs from "fs/promises";
import express from "express";

var secrets = JSON.parse(await fs.readFile("secrets.json"));
var discordToken = secrets.discordBotToken;
var myDiscordID = secrets.myDiscordID;
var myDiscordServerID = secrets.myDiscordServerID;
var myDiscordUser;

var spotifyClientID = secrets.spotifyClientID;
var spotifyClientSecret = secrets.spotifySecret;
var spotifyQueryBase = "https://api.spotify.com/v1";
var spotifyServerAuthString = "Basic " + Buffer.from(spotifyClientID + ":" + spotifyClientSecret).toString("base64");
var spotifyToken = "";
var spotifyRenewToken = "";
var spotifyTokenRenewer;
var timesUpTimeout;

var today = new Date();
var newDayTimeout;
//epoch time since playback started or null if not playing
var playingSince = null;
//time limit in minutes
var dailyTimeLimit = 1;
//also in minutes
var totalListeningTime = 0;

//in seconds
var checkingInterval = 30;
var spotifyCheckRunner;

var expressServer = express();
var expressPort = 8000;
var webPageHostname = process.env.HOST ?? "http://localhost:8000";

const discordBot = new Client({
	"intents": [
		"Guilds",
		"GuildMembers",
		"GuildPresences"
	]
});

//Initiates midnight reset timer
newDay();

await discordBot.login(discordToken);
console.log("discord bot logged in");
myDiscordUser = await discordBot.guilds.resolve(myDiscordServerID).members.fetch(myDiscordID);


discordBot.on("presenceUpdate", (oldPresence, newPresence) => {
	if (newPresence.userId != myDiscordID) return;
	discordPresenceUpdated(oldPresence, newPresence);
});

async function getSpotifyToken(code, requestPath) {
	var requestBody = {
		"grant_type": "authorization_code",
		"code": code,
		"redirect_uri": webPageHostname + requestPath
	};

	let response = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: {
			"Authorization": spotifyServerAuthString,
			"Content-Type": "application/x-www-form-urlencoded"
		},
		body: new URLSearchParams(requestBody)
	});

	let responseBody = await response.json();
	console.log(responseBody);
	if (response.status != 200) throw Error(JSON.stringify(responseBody));
	parseAccessToken(responseBody);
}

async function renewSpotifyToken() {
	let authorization = "Basic " + Buffer.from(spotifyClientID + ":" + spotifyClientSecret).toString("base64");
	let requestBody = {
		"grant_type": "refresh_token",
		"refresh_token": spotifyRenewToken
	}
	let response = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: {
			"Authorization": authorization,
			"Content-Type": "application/x-www-form-urlencoded"
		},
		body: new URLSearchParams(requestBody)
	});

	let responseText = await response.text();
	let responseBody = JSON.parse(responseText);
	if (response.status != 200) throw new Error(JSON.stringify(responseBody));
	parseAccessToken(responseBody);
}

function parseAccessToken(responseBody) {
	//Just in case this function's caller didn't get called through the timeout
	clearTimeout(spotifyTokenRenewer);

	spotifyToken = responseBody.access_token;
	spotifyRenewToken = responseBody.refresh_token;

	let nextRenewal = responseBody.expires_in - 10;
	spotifyTokenRenewer = setTimeout(renewSpotifyToken, nextRenewal * 1000, spotifyRenewToken);
}

expressServer.get("/", (req, res) => {
	res.status(302);
	res.appendHeader("Location", getAuthorizationURL());
	res.end("Redirecting...");
});


expressServer.get("/callback/spotify", async (req, res) => {

	if (!req.query.code) {
		res.status = 400;
		res.end("No code provided.");
		return;
	}
	let code = req.query.code;
	let path = req.path;
	try {
		await getSpotifyToken(code, path);
		res.end("Code parsed successfully");
		let myDiscordPresence = await onlineOnDiscord();
		if (myDiscordPresence) {
			discordPresenceUpdated(null, myDiscordPresence);
		}
		else {
			checkingInterval = setInterval(checkIfListening, checkingInterval * 1000);
		}
	}
	catch (e) {
		res.status(400);
		res.end("Failed to process your code.");
	}
});

function getAuthorizationURL() {
	let baseURL = "https://accounts.spotify.com/authorize";
	let paramObject = {
		client_id: spotifyClientID,
		response_type: "code",
		redirect_uri: webPageHostname + "/callback/spotify",
		scope: "user-read-playback-state user-modify-playback-state"
	}

	return baseURL + "?" + new URLSearchParams(paramObject);
}

function discordPresenceUpdated(oldPresence, newPresence) {
	console.log("my presence updated");
	if (oldPresence == null || (oldPresence.status != newPresence.status)) {
		clearInterval(spotifyCheckRunner);
		if ((!newPresence || newPresence.status == "offline") && spotifyToken) {
			spotifyCheckRunner = setInterval(checkIfListening, checkingInterval * 1000);
		}
	}
	checkDiscordForSpotify(newPresence);
}

function checkDiscordForSpotify(presence) {
	let spotifyFound = false;
	for (let activity of presence.activities) {
		if (activity.name != "Spotify") continue;
		spotifyFound = true;
		break;
	}

	if (spotifyFound) {
		listening();
	}
	else {
		notListening();
	}
}

async function checkIfListening() {
	let responseBody = await querySpotifyServer("GET", "/me/player");
	switch (responseBody.status) {
		case 200:
			let responseJSON = await responseBody.json();
			if (responseJSON.is_playing) listening();
			else notListening();
			break;
		case 204:
			notListening();
			break;
		default:
			throw new Error(responseBody.text);
	}
}

async function onlineOnDiscord() {
	if (myDiscordUser.presence == null || myDiscordUser.presence.status == "offline") return false;
	return myDiscordUser.presence;
}

function listening() {
	console.log("listening to spotify");
	clearTimeout(timesUpTimeout);
	if (playingSince != null) addUpListeningTime();
	playingSince = Date.now();

	if (totalListeningTime >= dailyTimeLimit) {
		pausePlayback();
		return;
	}
	timesUpTimeout = setTimeout(checkIfTimesUp, (dailyTimeLimit - totalListeningTime) * 60 * 1000);
	console.log("checking if time is up in " + (dailyTimeLimit - totalListeningTime) + " minutes.");
}

function notListening() {
	clearTimeout(timesUpTimeout);
	console.log("not listening to spotify");
	if (playingSince == null) return;

	addUpListeningTime();
}

function checkIfTimesUp() {
	addUpListeningTime();
	if (totalListeningTime >= dailyTimeLimit) {
		pausePlayback();
	}
	else {
		playingSince = Date.now();
	}
}

function addUpListeningTime() {
	let listenedTime = Date.now() - playingSince;
	totalListeningTime += listenedTime / 1000 / 60;
	playingSince = null;
}

async function querySpotifyServer(method, path) {
	return fetch(spotifyQueryBase + path, {
		"method": method,
		"headers": {
			"Authorization": "Bearer " + spotifyToken
		}
	});
}

function newDay() {
	let newDate = new Date();
	newDate.setHours(23, 59, 59, 999);

	if (newDate.getDate() == today.getDate() && newDate.getMonth() == today.getMonth() || newDate.getFullYear() == today.getFullYear()) {
		newDayTimeout = setTimeout(newDay, newDate.getTime() + 1 - Date.now());
	}
	totalListeningTime = 0;
	playingSince = new Date(newDate.getTime() + 1);
	today = newDate;
	newDayTimeout = setTimeout(newDay, 24 * 60 * 60 * 1000);
}

async function pausePlayback() {
	let requestBody = await querySpotifyServer("PUT", "/me/player/pause")
	let messageToUser = "Deine Spotify-Zeit für heute ist abgelaufen!\n";
	console.log("Stop listening now!");
	if (requestBody.ok) {
		messageToUser += "Ich habe Deine Wiedergabe pausiert.";
	}
	else {
		messageToUser += "Ich konnte Deine Wiedergabe nicht pausieren.";
	}
	myDiscordUser.send(messageToUser);
}

expressServer.listen(expressPort, () => {
	console.log("Server listening");
});