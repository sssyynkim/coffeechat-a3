const { SQSClient } = require("@aws-sdk/client-sqs");
const AWS = require("aws-sdk");
const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const cookieParser = require("cookie-parser");
const { connectDB } = require("./config/db");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const flash = require("connect-flash");
const passport = require("./config/passport");
const cors = require("cors");
const { getDB } = require("./config/db");
const ensureAuthenticated = require("./middleware/auth");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { getParameterValue } = require("./config/secretsManager");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");
const {
  CognitoIdentityProviderClient,
} = require("@aws-sdk/client-cognito-identity-provider");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
// 필요한 SQS 명령어 추가
const {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require("@aws-sdk/client-sqs");

const app = express();
const server = http.createServer(app);

// WebSocket 서버 설정 (파일 업로드와 채팅 모두 처리)
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("WebSocket connected");

  ws.on("message", (message) => {
    console.log("Received:", message);

    // 메시지가 JSON 형식인지 확인하고 처리
    try {
      const parsedMessage = JSON.parse(message);

      // 메시지에 따라 처리 분기
      if (parsedMessage.action === "upload") {
        console.log("Upload message received:", parsedMessage.data);
        // 업로드 관련 처리
      } else if (parsedMessage.action === "chat") {
        console.log("Chat message received:", parsedMessage.data);
        // 채팅 관련 처리
      }
    } catch (error) {
      console.log("Received non-JSON message:", message);
      // 메시지가 단순 문자열일 때 처리
    }

    // 에코 메시지
    ws.send(`Echo: ${message}`);
  });

  ws.on("close", () => {
    console.log("WebSocket disconnected");
  });
});

let cognitoClient; // Global declaration for Cognito

// // Initialize AWS SDK
// async function initializeAWS() {
//     const secret = await getSecretValue('n11725605-assignment2-latest');
//     AWS.config.update({
//         accessKeyId: secret.accessKeyId,
//         secretAccessKey: secret.secretAccessKey,
//         sessionToken: secret.sessionToken || '',
//         region: 'ap-southeast-2'
//     });
//     console.log('AWS SDK initialized with credentials from Secrets Manager.');
// }

// AWS SDK 및 자격 증명 초기화
async function initializeAWS() {
  const accessKeyId = await getParameterValue("/n11725605/prac-accessKeyId");
  const secretAccessKey = await getParameterValue(
    "/n11725605/prac-secretAccessKey"
  );
  const sessionToken = await getParameterValue("/n11725605/prac-sessionToken");
  const region = await getParameterValue("/n11725605/prac-region");

  AWS.config.update({
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
    sessionToken: sessionToken,
    region: region,
  });

  console.log("AWS SDK initialized with credentials from Parameter Store.");
}

// Ensure Cognito is initialized before login API
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    if (!cognitoClient) {
      await initializeCognito(); // Initialize if not already done
    }

    const authResult = await authenticateUser(username, password);

    // Store token in the session or return it to the client
    req.session.token = authResult.AccessToken;
    res.json({
      success: true,
      idToken: authResult.IdToken,
      accessToken: authResult.AccessToken,
      refreshToken: authResult.RefreshToken, // If you need a refresh token
    });
  } catch (error) {
    console.error("Login failed:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// // Initialize Cognito SDK
// async function initializeCognito() {
//   try {
//     // Fetch Cognito configuration from AWS Secrets Manager and Parameter Store
//     const secret = await getSecretValue("n11725605-assignment2-latest");
//     const region = await getParameterValue("/n11725605/AWS_REGION");

//     cognitoClient = new CognitoIdentityProviderClient({
//       region: region,
//       credentials: {
//         accessKeyId: secret.accessKeyId,
//         secretAccessKey: secret.secretAccessKey,
//         sessionToken: secret.sessionToken || "", // Optional session token if available
//       },
//     });

//     console.log("Cognito initialized successfully.");
//   } catch (error) {
//     console.error("Error initializing AWS Cognito:", error);
//     throw new Error("Failed to initialize AWS Cognito settings");
//   }
// }

// Cognito 초기화
async function initializeCognito() {
  try {
    const region = await getParameterValue("/n11725605/prac-region");

    cognitoClient = new CognitoIdentityProviderClient({
      region: region,
      credentials: {
        accessKeyId: await getParameterValue("/n11725605/prac-accessKeyId"),
        secretAccessKey: await getParameterValue(
          "/n11725605/prac-secretAccessKey"
        ),
        sessionToken: await getParameterValue("/n11725605/prac-sessionToken"),
      },
    });

    console.log("Cognito initialized successfully.");
  } catch (error) {
    console.error("Error initializing AWS Cognito:", error);
    throw new Error("Failed to initialize AWS Cognito settings");
  }
}

// MongoDB connection
async function connectToMongoDB() {
  await connectDB();
  console.log("Connected to MongoDB successfully");
}

// S3 Client setup
async function createS3Client() {
  return new S3Client({
    region: await getParameterValue("/n11725605/prac-region"),
    credentials: {
      accessKeyId: await getParameterValue("/n11725605/prac-accessKeyId"),
      secretAccessKey: await getParameterValue(
        "/n11725605/prac-secretAccessKey"
      ),
      sessionToken: await getParameterValue("/n11725605/prac-sessionToken"),
    },
  });
}

// DynamoDB Client creation
async function createDynamoDBClient() {
  const client = new DynamoDBClient({
    region: await getParameterValue("/n11725605/prac-region"),
    credentials: {
      accessKeyId: await getParameterValue("/n11725605/prac-accessKeyId"),
      secretAccessKey: await getParameterValue(
        "/n11725605/prac-secretAccessKey"
      ),
      sessionToken: await getParameterValue("/n11725605/prac-sessionToken"),
    },
  });
  return DynamoDBDocumentClient.from(client);
}

// SQS Client setup
async function createSQSClient() {
  return new SQSClient({
    region: await getParameterValue("/n11725605/prac-region"),
    credentials: {
      accessKeyId: await getParameterValue("/n11725605/prac-accessKeyId"),
      secretAccessKey: await getParameterValue(
        "/n11725605/prac-secretAccessKey"
      ),
      sessionToken: await getParameterValue("/n11725605/prac-sessionToken"),
    },
  });
}

// SQS로 메시지 전송
// SQS로 메시지 전송
async function sendMessageToSQS(messageBody) {
  try {
    const sqsClient = await createSQSClient();
    const queueUrl =
      "https://sqs.ap-southeast-2.amazonaws.com/901444280953/n11682957-coffeechat-queue"; // SQS Queue URL

    const params = {
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(messageBody), // 메시지를 JSON으로 변환
    };

    const command = new SendMessageCommand(params);
    const response = await sqsClient.send(command);

    console.log("SQS Message Sent", response.MessageId);

    // WebSocket 클라이언트에게 실시간 알림 전송
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ action: "newPost", data: messageBody }));
      }
    });
  } catch (error) {
    console.error("Error sending message to SQS:", error);
  }
}

// 메시지 처리 로직
// 메시지 처리 로직
async function processSQSMessages() {
  try {
    const sqsClient = await createSQSClient();
    const receiveCommand = new ReceiveMessageCommand({
      QueueUrl:
        "https://sqs.ap-southeast-2.amazonaws.com/901444280953/n11682957-coffeechat-queue",
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
    });

    const receiveResponse = await sqsClient.send(receiveCommand);
    const messages = receiveResponse.Messages;

    if (!messages || messages.length === 0) {
      console.log("No messages in the queue.");
      return;
    }

    const message = messages[0];
    console.log("Processing message:", message.Body);

    // WebSocket을 통해 실시간 알림 전송
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(`New post notification: ${message.Body}`);
      }
    });

    // 메시지 삭제
    const deleteCommand = new DeleteMessageCommand({
      QueueUrl:
        "https://sqs.ap-southeast-2.amazonaws.com/901444280953/n11682957-coffeechat-queue",
      ReceiptHandle: message.ReceiptHandle,
    });
    const deleteResponse = await sqsClient.send(deleteCommand);
    console.log("Message deleted:", deleteResponse);
  } catch (error) {
    console.error("Error processing SQS message:", error);
  }
}

// IIFE to handle async initialization and start the server
(async function startServer() {
  try {
    // Initialize all services sequentially
    await initializeAWS();
    await initializeCognito(); // Initialize Cognito separately
    await connectToMongoDB(); // Connect to MongoDB after Cognito
    console.log("All services initialized successfully.");

    // // Initialize all services sequentially
    // await Promise.all([initializeAWS(), initializeCognito(), connectToMongoDB()]);

    // Middleware Setup
    app.use(
      cors({
        origin: ["http://localhost:8080"], //"https://www.coffeechat.cab432.com"
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
        credentials: true,
        optionsSuccessStatus: 204,
      })
    );

    app.use("/uploads", express.static(path.join(__dirname, "uploads")));
    app.use(
      "/node_modules",
      express.static(path.join(__dirname, "node_modules"))
    );
    app.use(express.static(path.join(__dirname, "public")));
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    // const sessionSecret = (await getSecretValue("n11725605-assignment2-latest"))
    //   .SESSION_SECRET;
    const sessionSecret = await getParameterValue(
      "/n11725605/prac-SESSION_SECRET"
    );
    const dbUrl = await getParameterValue("/n11725605/DB_URL");
    app.use(
      session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        store: MongoStore.create({ mongoUrl: dbUrl }),
        cookie: { maxAge: 3600000 }, // 1 hour
      })
    );

    app.use(flash());
    app.use((req, res, next) => {
      res.locals.success_msg = req.flash("success_msg");
      res.locals.error_msg = req.flash("error_msg");
      next();
    });

    app.use((req, res, next) => {
      res.locals.user = req.user || null; // 로그인된 사용자 정보가 있으면 `user`로 전달, 없으면 null
      next();
    });

    // Passport Setup
    app.use(passport.initialize());
    app.use(passport.session());

    // View Engine Setup
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "views"));

    //configureSocketIO(io);

    // Routes for posts, comments, and chat
    const authRoutes = require("./routes/authRoutes");
    const postRoutes = require("./routes/postRoutes");
    const chatRoutes = require("./routes/chatRoutes");
    const commentRoutes = require("./routes/commentRoutes");

    app.use("/auth", authRoutes);
    app.use("/posts", ensureAuthenticated, postRoutes);
    app.use("/chat", ensureAuthenticated, chatRoutes);
    app.use("/comment", ensureAuthenticated, commentRoutes);

    // Home route
    app.get("/", async (req, res) => {
      try {
        const db = getDB();
        let userPosts = [];

        if (req.session.token) {
          userPosts = await db.collection("post").find().toArray();
        }

        // Render the index.ejs view with the retrieved posts
        res.render("index", {
          user: req.session.token ? true : false,
          posts: userPosts,
        });
      } catch (err) {
        console.error("Error fetching posts:", err);
        res.status(500).send("Internal Server Error");
      }
    });

    // Route for file upload using AWS S3
    app.post(
      "/upload",
      ensureAuthenticated,
      upload.single("file"),
      async (req, res) => {
        if (!req.file) return res.status(400).send("No file uploaded.");

        const userId = req.user.sub;
        const email = req.user.email;
        const s3Client = await createS3Client();

        const bucketName = await getParameterValue(
          "/n11725605/AWS_BUCKET_NAME"
        );
        const region = await getParameterValue("/n11725605/AWS_REGION");
        const params = {
          Bucket: bucketName,
          Key: `${userId}/${req.file.originalname}`,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
          Metadata: { "uploaded-by": email },
        };

        try {
          const command = new PutObjectCommand(params);
          await s3Client.send(command);

          const fileUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${userId}/${req.file.originalname}`;
          const docClient = await createDynamoDBClient();
          const postId = uuidv4();

          const postData = {
            "qut-username": await getParameterValue("/n11725605/QUT_USERNAME"),
            postId: postId,
            title: req.body.title,
            content: req.body.content,
            imageUrl: fileUrl,
            timestamp: new Date().toISOString(),
            uploadedBy: userId,
          };

          await docClient.send(
            new PutCommand({
              TableName: await getParameterValue(
                "/n11725605/DYNAMO_TABLE_NAME"
              ),
              Item: postData,
            })
          );

          const messageBody = {
            postId: postId,
            title: req.body.title,
            content: req.body.content,
            imageUrl: fileUrl,
            userId: userId,
          };

          await sendMessageToSQS(messageBody); // SQS로 메시지 전송

          res
            .status(201)
            .send({ message: "Post created successfully", postId });
        } catch (err) {
          console.error("Error uploading file or adding post:", err);
          res.status(500).send("File upload failed or post creation failed");
        }
      }
    );

    app.get("/posts/presigned-url", async (req, res) => {
      const fileName = req.query.fileName; // 요청된 파일 이름
      const s3Client = await createS3Client(); // S3 클라이언트 생성
      const bucketName = await getParameterValue("/n11725605/AWS_BUCKET_NAME");

      const params = {
        Bucket: bucketName,
        Key: fileName,
        Expires: 60, // URL 만료 시간(초)
      };

      try {
        const command = new GetObjectCommand(params);
        const preSignedUrl = await getSignedUrl(s3Client, command, {
          expiresIn: 60,
        });
        res.json({ url: preSignedUrl });
      } catch (err) {
        console.error("Error generating pre-signed URL:", err);
        res.status(500).json({ error: "Error generating pre-signed URL" });
      }
    });

    // Other routes and configurations...

    const PORT = await getParameterValue("/n11725605/PORT");
    // const server = http.createServer(app);
    // configureSocketIO(server);
    server.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Error starting the server:", error);
    process.exit(1);
  }
})();

module.exports = { createSQSClient };
