const AWS = require('aws-sdk');

// Use Secret Manager for getting the email credentials
// const secretsManager = new AWS.SecretsManager({region: "eu-west-2"});

// Use SSM Parameter Store for getting the email credentials
const ssm = new AWS.SSM({region: "eu-west-2"});

// Used for email auditing
const s3 = new AWS.S3({region: "eu-west-2"});

exports.handler = async (event, context, callback) => {

    var responseBody = {};
    var statusCode = '400';
    
    var body = event.body;
    console.log("Body = " + JSON.stringify(body));
    
    // The name of the parameter to fetch from Secret Manager or SSM Parameter Store
    const emailSecretName = body["secretName"];
    
    // The 'to' name and address: 'name <email>'' or just 'email'
    const emailAddressTo = body["toAddress"];
    
    // Email title
    const emailTitle = body["title"];
    
    // Email body (in HTML)
    const emailText = body["text"];
    
    // Attachments
    const emailEncodedAttachment = body["encodedAttachment"];
    const emailAttachmentName = body["attachmentName"];
    const emailAttachments = body["attachments"];
    
    // Reply-to (optional)
    const emailReplyTo = body["replyTo"];

    const useTestEmail = emailSecretName == "test" || (process.env.TEST_EMAILS_ONLY == "true");
    const auditBucket = process.env.AUDIT_BUCKET;
    var auditMode;
    var attachments = [];

    "use strict";
    const nodemailer = require("nodemailer");
    
    try {
        
        var transporter;
        var fromAddress;
        
        if (useTestEmail)
        {
          // Generate test SMTP service account from ethereal.email
          // Only needed if you don't have a real mail account for testing
          let testAccount = await nodemailer.createTestAccount();
        
          // Create reusable transporter object using the default SMTP transport
          let testTransporter = nodemailer.createTransport({
            host: "smtp.ethereal.email",
            port: 587,
            secure: false, // true for 465, false for other ports
            auth: {
              user: testAccount.user, // generated ethereal user
              pass: testAccount.pass, // generated ethereal password
            },
          });
          
          transporter = testTransporter;
          fromAddress = '"Test Sender" <test@test>';
        }
        else
        {
            // Get secret from AWS Secrets Manager
            // var emailSecret = JSON.parse((await secretsManager.getSecretValue({ SecretId: emailSecretName }).promise()).SecretString);
            
            // Get secret from AWS Parameter Store (System Manager)
            var emailSecret = JSON.parse((await ssm.getParameter({"Name" : emailSecretName, "WithDecryption": true}).promise()).Parameter.Value);
            // console.log("Secret = " + JSON.stringify(emailSecret));
            
            // Get the audit settings
            auditMode = emailSecret["audit"];
            
            // console.log("Username = " + emailSecret["username"]);
  
            if (emailSecret["type"] == "login")
            {
                transporter = nodemailer.createTransport({
                    // logger: true,
                    // debug: true,
                    host: emailSecret["host"],
                    port: parseInt(emailSecret["port"]),
                    secure: emailSecret["secure"] == "true", // true for 465, false for other ports
                    ignoreTLS: emailSecret["ignoreTLS"] == "true", 
                    auth: {
                        user: emailSecret["username"],
                        pass: emailSecret["password"]
                    }
                 });
            }
            else if (emailSecret["type"] == "OAuth2")
            {
                transporter = nodemailer.createTransport({
                    host: emailSecret["host"],
                    port: parseInt(emailSecret["port"]),
                    secure: emailSecret["secure"] == "true", // true for 465, false for other ports
                    auth: {
                            type: emailSecret["type"],
                            user: emailSecret["username"],
                            clientId: emailSecret["clientId"],
                            clientSecret: emailSecret["clientSecret"],
                            refreshToken: emailSecret["refreshToken"],
                            accessToken: emailSecret["accessToken"],
                            expires: 3599
                    }
                 });
            }
            fromAddress = '"' + emailSecret["displayName"] + '" <' + emailSecret["username"] + '>';
        }
        
        // Adding all attachments
        if (typeof emailAttachments !== 'undefined')
        {
            emailAttachments.forEach(function(emailAttachment){
                attachments.push({
                    filename: emailAttachment["attachmentName"],
                    content: Buffer.from(emailAttachment["encodedAttachment"], 'base64')
                });
            });
        } else if (typeof emailAttachmentName !== 'undefined' && typeof emailEncodedAttachment !== 'undefined')
        {
            attachments.push({
                filename: emailAttachmentName,
                content: Buffer.from(emailEncodedAttachment, 'base64')
            });
        }
        
        // console.log("Sending mail to " + emailAddressTo);
        
        const emailContent = {
            from: fromAddress,
            to: emailAddressTo,
            subject: emailTitle, 
            html: emailText,
            attachments: attachments,
            replyTo: emailReplyTo
        };
        if (auditMode == "bcc")
        {
            // bcc can be used for storing a copy if not done by the mail server 
            emailContent["bcc"] = fromAddress;
        }
        
        let info = await transporter.sendMail(emailContent);
        
        // Uploading files to the bucket
        if (auditMode == "s3")
        {
            s3.upload({
                Bucket: auditBucket,
                Key: emailSecretName + "/" + info.messageId + "-" + emailAddressTo + "-" + emailTitle + ".json",
                Body: JSON.stringify(emailContent)
            }, function(err, data) {
                if (err) {
                    throw err;
                }
                console.log(`Audit file uploaded successfully: ${data.Location}`);
            });
        }
        
        console.log("Message ID: %s", info.messageId);
        responseBody["messageId"] = info.messageId;
        responseBody["previewUrl"] = nodemailer.getTestMessageUrl(info);
        statusCode = '200';

        // Preview only available when sending through an Ethereal account
        console.log("Preview URL: %s", nodemailer.getTestMessageUrl(info));

    } catch (e) 
    {
        console.log("Error = " + e.message);
        responseBody["message"] = e.message;
    }
    
    var response = {
        "statusCode": statusCode,
        "body": responseBody,
    };
    
    // console.log("Response: " + JSON.stringify(response));
    
    callback(null, response);
};