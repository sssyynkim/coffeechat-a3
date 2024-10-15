// const { Server } = require('socket.io');
// const passportSocketIo = require('passport.socketio');
// const cookieParser = require('cookie-parser');
// const MongoStore = require('connect-mongo');
// const { getDB } = require('../config/db'); // Already fetching DB configuration securely
// const { ObjectId } = require('mongodb');
// const { getParameterValue } = require('../config/secretsManager'); // Helper to fetch secrets

// async function configureSocketIO(server) {
//   const io = new Server(server);

//   // Fetch the session secret and DB URL securely from AWS
//   const sessionSecret = await getParameterValue('/n11725605/SESSION_SECRET');
//   const dbUrl = await getParameterValue('/n11725605/DB_URL');

//   io.use(passportSocketIo.authorize({
//     cookieParser: cookieParser,
//     key: 'connect.sid', // This is the default cookie name for express-session
//     secret: sessionSecret, // Use the securely fetched session secret
//     store: MongoStore.create({
//       mongoUrl: dbUrl, // Use the securely fetched MongoDB URL
//       dbName: 'coffeechat_ys', // Replace this if your database name differs
//     }),
//     success: (data, accept) => {
//       console.log('Successful connection to socket.io');
//       accept(null, true);
//     },
//     fail: (data, message, error, accept) => {
//       if (error) {
//         accept(new Error(message));
//       }
//       console.log('Failed connection to socket.io:', message);
//       accept(null, false);
//     }
//   }));

//   io.on('connection', (socket) => {
//     console.log('WebSocket connected');

//     socket.on('ask-join', (room) => {
//       socket.join(room);
//       console.log(`User joined room: ${room}`);
//     });

//     socket.on('message-send', async (data) => {
//       try {
//         const user = socket.request.user;
//         const timestamp = new Date();

//         if (!user) {
//           console.error('User not found.');
//           return;
//         }

//         const db = getDB(); // Fetch database connection
//         await db.collection('chatMessage').insertOne({
//           parentRoom: new ObjectId(data.room),
//           content: data.msg,
//           who: new ObjectId(user._id),
//           username: user.username,
//           timestamp: timestamp
//         });

//         const messageData = {
//           username: user.username || 'Anonymous',
//           msg: data.msg,
//           timestamp: timestamp
//         };

//         io.to(data.room).emit('newMessage', messageData);

//       } catch (err) {
//         console.error('Error handling message-send event:', err);
//       }
//     });
//   });
// }

// module.exports = configureSocketIO;

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { createDynamoDBClient } = require("../controllers/dynamoController"); // DynamoDB client function
const { PutCommand } = require("@aws-sdk/lib-dynamodb"); // DynamoDB PutCommand
const axios = require("axios");
const { getParameterValue } = require("../config/secretsManager"); // AWS Secrets Manager

async function configureSocketIO(server) {
  const io = new Server(server);

  // AWS Parameter Store에서 Cognito User Pool ID와 Region 값 가져오기
  const COGNITO_USER_POOL_ID = await getParameterValue(
    "/n11725605/COGNITO_USER_POOL_ID"
  );
  const AWS_REGION = await getParameterValue("/n11725605/prac-region");
  const QUT_USERNAME = await getParameterValue("/n11725605/QUT_USERNAME");
  const TABLE_NAME = "n11725605-ChatMessages";

  // WebSocket을 사용할 때 JWT 인증
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error("Authentication token is required."));
    }

    try {
      // JWT 토큰을 검증하기 위해 Cognito User Pool의 공개 키를 사용
      const decodedToken = jwt.verify(
        token,
        await getCognitoPublicKey(COGNITO_USER_POOL_ID, AWS_REGION)
      );
      socket.user = decodedToken; // 검증된 사용자 정보를 WebSocket에 저장
      next();
    } catch (error) {
      console.error("JWT verification failed:", error);
      next(new Error("Authentication failed."));
    }
  });

  // WebSocket 연결 처리
  io.on("connection", (socket) => {
    console.log("WebSocket connected");

    // 특정 채팅방에 연결 요청 시
    socket.on("ask-join", (room) => {
      socket.join(room);
      console.log(`User joined room: ${room}`);
    });

    // socket.on("message-send", async (data) => {
    //   console.log("Message received on server:", data); // 로그 추가

    //   try {
    //     const user = socket.user; // Cognito에서 받은 WebSocket 사용자 정보
    //     const serverTimestamp = new Date().toISOString();
    //     const postId = require("uuid").v4(); // 각 메시지에 고유 ID 생성

    //     if (!user) {
    //       console.error("User not found.");
    //       return;
    //     }

    //     // 메시지를 DynamoDB에 저장
    //     const docClient = await createDynamoDBClient();
    //     const messageData = {
    //       "qut-username": QUT_USERNAME, // 고정된 partition key 값
    //       postId: postId, // 메시지의 고유 ID (UUID)
    //       roomId: data.room, // 채팅방 ID
    //       message: data.msg, // 메시지 내용
    //       username: user.username, // Cognito 사용자 이름
    //       uploadedBy: user.sub, // Cognito 사용자 ID
    //       timestamp: serverTimestamp, // 메시지 전송 시간
    //     };

    //     const putCommand = new PutCommand({
    //       TableName: TABLE_NAME,
    //       Item: messageData,
    //     });

    //     // DynamoDB에 메시지 저장
    //     await docClient.send(putCommand);
    //     console.log("Message saved to DynamoDB:", messageData);

    //     // 해당 방에 있는 모든 사용자에게 메시지 브로드캐스트
    //     console.log("Broadcasting message to room:", data.room);
    //     io.to(data.room).emit("newMessage", messageData); // 클라이언트로 메시지 브로드캐스트
    //   } catch (err) {
    //     console.error("Error sending message:", err);
    //   }
    // });
    socket.on("message-send", async (data) => {
      try {
        console.log("Message received on server:", data);

        // 서버 시간으로 타임스탬프 생성
        const serverTimestamp = new Date().toISOString();
        console.log("Server Timestamp:", serverTimestamp);

        // 메시지 데이터 생성
        const messageData = {
          msg: data.msg,
          room: data.room,
          username: data.username,
          timestamp: serverTimestamp, // 서버 타임스탬프를 클라이언트로 전달
        };

        console.log("Prepared message data:", messageData);

        // 메시지 브로드캐스트
        io.to(data.room).emit("newMessage", messageData);
        console.log("Message broadcasted to room:", data.room);
      } catch (error) {
        console.error("Error in message-send event:", error);
      }
    });
  });
}

// Cognito의 공개 키를 가져오기 위한 함수
async function getCognitoPublicKey(userPoolId, region) {
  const url = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
  const { data } = await axios.get(url);
  return data.keys[0]; // Cognito의 JWT 공개 키 반환
}

module.exports = configureSocketIO;
