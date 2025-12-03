// GET /api/dashboard/rankings
const getGlobalRankings = async (req, res) => {
  try {
    const userId = req.user._id; // from auth middleware

    // Aggregate all users' performance metrics
    const rankings = await User.aggregate([
      {
        $lookup: {
          from: "quizresults",
          localField: "_id",
          foreignField: "userId",
          as: "results"
        }
      },
      {
        $addFields: {
          totalScore: {
            $sum: {
              $map: {
                input: "$results",
                as: "r",
                in: { $multiply: ["$$r.score", "$$r.quiz.numQuestions"] }
              }
            }
          },
          totalQuestions: {
            $sum: {
              $map: {
                input: "$results",
                as: "r",
                in: { $ifNull: ["$$r.quiz.numQuestions", 0] }
              }
            }
          },
          quizzesTaken: { $size: "$results" }
        }
      },
      {
        $addFields: {
          averageScore: {
            $cond: [
              { $gt: ["$totalQuestions", 0] },
              { $round: [{ $divide: ["$totalScore", "$totalQuestions"] }, 1] },
              0
            ]
          },
          accuracy: {
            $cond: [
              { $gt: ["$totalQuestions", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          { $sum: { $map: { input: "$results", as: "r", in: "$$r.correctCount" } } },
                          "$totalQuestions"
                        ]
                      },
                      100
                    ]
                  },
                  1
                ]
              },
              0
            ]
          }
        }
      },
      {
        $project: {
          userId: "$_id",
          fullName: 1,
          averageScore: 1,
          accuracy: 1,
          quizzesTaken: 1,
          totalQuestions: 1,
          streak: { $ifNull: ["$currentStreak", 0] }
        }
      },
      {
        $addFields: {
          performanceScore: {
            $add: [
              { $multiply: ["$averageScore", 0.5] },
              { $multiply: ["$accuracy", 0.3] },
              { $multiply: ["$quizzesTaken", 5] },
              { $multiply: ["$streak", 2] }
            ]
          }
        }
      },
      { $sort: { performanceScore: -1 } },
      {
        $group: {
          _id: null,
          users: { $push: "$$ROOT" },
          totalUsers: { $sum: 1 }
        }
      },
      {
        $unwind: { path: "$users", includeArrayIndex: "rank" }
      },
      {
        $project: {
          _id: 0,
          rank: { $add: ["$rank", 1] },
          userId: "$users.userId",
          fullName: "$users.fullName",
          averageScore: "$users.averageScore",
          accuracy: "$users.accuracy",
          quizzesTaken: "$users.quizzesTaken",
          performanceScore: "$users.performanceScore"
        }
      }
    ]);

    const userRank = rankings.find(r => r.userId.toString() === userId.toString());
    const top10 = rankings.slice(0, 10);

    res.json({
      success: true,
      myRank: userRank ? userRank.rank : null,
      myPercentile: userRank ? Math.round((1 - userRank.rank / rankings.length) * 100) : 0,
      totalUsers: rankings.length,
      top10,
      leaderboard: rankings.slice(0, 50)
    });
  } catch (error) {
    console.error("Ranking error:", error);
    res.status(500).json({ error: "Failed to load rankings" });
  }
};

module.exports = { getGlobalRankings };