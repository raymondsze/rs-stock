var https = require('https');

// CONFIGURATION #######################################################################################################

var token          = 'xoxp-327204706563-327424609557-331738339843-a850316fac6f8e369332a1ecd7bdc7dd';
var channel        = 'C9SL3HNBY';
var privateChannel = false;
var delay          = 10; // delay between delete operations in millisecond

// GLOBALS #############################################################################################################

var channelApi    = privateChannel ? 'groups' : 'channels';
var baseApiUrl    = 'https://slack.com/api/';
var historyApiUrl = baseApiUrl + channelApi + '.history?token=' + token + '&count=1000&channel=' + channel;
var deleteApiUrl  = baseApiUrl + 'chat.delete?token=' + token + '&channel=' + channel + '&ts='
var messages      = [];

// ---------------------------------------------------------------------------------------------------------------------

function deleteMessage() {

    if (messages.length == 0) {
        return;
    }

    var ts = messages.shift();

    https.get(deleteApiUrl + ts, function (res) {

        var body = '';

        res.on('data', function (chunk) {
            body += chunk;
        });

        res.on('end', function(){
            var response = JSON.parse(body);

            if (response.ok === true) {
                console.log(ts + ' deleted!');
            } else if (response.ok === false) {
                messages.push(ts);
            }

            setTimeout(deleteMessage, delay);
        });
    }).on('error', function (e) {
        console.log("Got an error: ", e);
    });
}

// ---------------------------------------------------------------------------------------------------------------------

https.get(historyApiUrl, function(res) {

    var body = '';

    res.on('data', function (chunk) {
        body += chunk;
    });

    res.on('end', function () {

        var response = JSON.parse(body);
  
        for (var i = 0; i < response.messages.length; i++) {
            messages.push(response.messages[i].ts);
        }

        deleteMessage();
    });
}).on('error', function (e) {
      console.log("Got an error: ", e);
});