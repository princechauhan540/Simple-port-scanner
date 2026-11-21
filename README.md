# Simple Port Scanner

A browser GUI for TCP connect scans, built with HTML, CSS, JavaScript, and Node.js. The local server opens a TCP connection to each selected port and streams the results to the browser.

## Run

Install Node.js 20 or newer. Download or clone this repository, open a terminal in the project folder, and run

```sh
node server.js
```

You can also use `npm start`. No package installation is required.

Open http://127.0.0.1:3000 in Chrome. Enter a hostname or IP address, choose ports, and select **Start scan**. The default target is your own computer. Keep the terminal open while using the website.

If port 3000 is busy, choose another server port in PowerShell

```powershell
$env:PORT = '3001'
node server.js
```

## Features

- Scan one hostname, IPv4 address, or IPv6 address.
- Enter comma-separated ports and ranges, such as `22,80,443,8000-8010`.
- See results as they arrive, stop a scan, filter open ports, and export a CSV.
- Choose a connection timeout from 500 to 5000 milliseconds.
- Scan up to 256 unique ports per request, with up to 24 concurrent connections.

## Reading results

**Open** means a TCP connection succeeded. **Closed** means the connection was refused. **Timeout** means the deadline passed without a conclusive response. **Error** reports a network failure. Service names show typical uses of port numbers. They do not identify the software running on a port.

This project scans TCP ports. Results reflect connectivity from the computer running the Node.js server. Scan hosts you own or have permission to test.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | Local HTTP server, validation, and TCP scanner |
| `index.html` | Website structure |
| `styles.css` | Responsive interface |
| `app.js` | Scan controls and streamed results |

The server listens on the local loopback interface. The GUI needs this server to perform real TCP checks. GitHub Pages can serve static files, while this application runs with Node.js on your computer.
